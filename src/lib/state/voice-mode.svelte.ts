import { browser } from '$app/environment';
import type { SpeechPrivacy } from '$lib/private-speech.js';
import { speakableUpTo } from '$lib/speakable-text.js';
import { unlockVoiceAudio } from './voice-audio.js';
import { canListen, createVoiceListener } from './voice-listener.svelte.js';
import { createVoiceSpeaker } from './voice-speaker.svelte.js';

/** How long a reply's opening clause must be before it is spoken on its own. */
const FIRST_CLAUSE_CHARS = 35;

export type VoicePhase =
	'off' | 'starting' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking';

/** The reply voice mode is waiting on: the newest assistant message in the chat. */
export type VoiceReply = { id: string; text: string } | null;

/**
 * Voice mode works in this browser with this setup. In a private chat
 * (`isPrivate`, default true) it needs server speech to text: the browser's
 * recognition sends audio to Google.
 */
export function voiceModeSupported(
	sttModel: { providerId: string; modelId: string } | null,
	serverTts: boolean,
	isPrivate = true
): boolean {
	if (!browser || !canListen(sttModel, isPrivate)) return false;
	return serverTts || 'speechSynthesis' in window;
}

export type VoiceMode = ReturnType<typeof createVoiceMode>;

/**
 * A spoken conversation on top of the regular chat: the user talks, each turn
 * is sent as an ordinary message, and the reply is read aloud as it streams
 * in, after which it listens again. Talking over the reply cuts it off.
 */
export function createVoiceMode(options: {
	sttModel: { providerId: string; modelId: string } | null;
	serverTts: () => boolean;
	/** The chat voice mode talks in (default: private); see SpeechPrivacy. */
	privacy?: () => SpeechPrivacy;
	volume: () => number;
	/** Sends what the user said as a chat message; false if it didn't go out. */
	send: (text: string) => Promise<boolean>;
	/**
	 * Replaces the last message voice mode sent with `text` (the user went on
	 * talking before the reply was heard); false if it didn't go out.
	 */
	revise: (text: string) => Promise<boolean>;
	/** Stops the reply being generated. */
	interrupt: () => void;
	onerror: (message: string) => void;
}) {
	let active = $state(false);
	let starting = $state(false);
	/** Waiting on (or reading) the reply to what the user just said. */
	let answering = $state(false);
	/** What the user said last, shown until the next turn. */
	let lastHeard = $state('');

	/** The newest reply when the user's message went out; a different one is the answer. */
	let before: string | null = null;
	let latest: VoiceReply = null;
	/** The reply has been generating since the message went out. */
	let sawBusy = false;
	/** Where in the reply's markdown reading has got to. */
	let consumed = 0;
	/** The reply is still arriving: more text will be pushed. */
	let streamingReply = false;
	/**
	 * What was sent last, when the user went on talking before its reply was
	 * heard: the next turn is added to it and replaces that message.
	 */
	let continuing: string | null = null;
	let wakeLock: WakeLockSentinel | null = null;

	const speaker = createVoiceSpeaker({
		serverTts: options.serverTts,
		privacy: options.privacy,
		volume: options.volume,
		onerror: options.onerror,
		// The barge-in detector relearns the room with the assistant's voice in it.
		onplaying: () => listener.rearmBargeIn()
	});

	const listener = createVoiceListener({
		sttModel: options.sttModel,
		privacy: options.privacy,
		onturn: (text) => void turn(text),
		onbargein: () => cutOff(true),
		onerror: options.onerror,
		onfatal: () => stop()
	});

	const phase: VoicePhase = $derived.by(() => {
		if (!active) return starting ? 'starting' : 'off';
		if (answering) return speaker.speaking ? 'speaking' : 'thinking';
		if (listener.transcribing) return 'transcribing';
		return listener.hearing ? 'hearing' : 'listening';
	});

	async function start() {
		if (active || starting) return;
		// Before any await, while the click still counts as a user gesture.
		unlockVoiceAudio();
		starting = true;
		const opened = await listener.open();
		starting = false;
		if (!opened) return;
		active = true;
		lastHeard = '';
		void lockScreen();
		listen();
	}

	function stop() {
		active = false;
		starting = false;
		answering = false;
		streamingReply = false;
		continuing = null;
		speaker.stop();
		listener.close();
		void wakeLock?.release().catch(() => {});
		wakeLock = null;
	}

	/** Keeps a phone's screen on through the conversation. */
	async function lockScreen() {
		try {
			wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
		} catch {
			// Not supported or not allowed: the screen may dim, voice mode still works.
		}
	}

	function listen() {
		if (!active) return;
		answering = false;
		streamingReply = false;
		listener.listen();
	}

	async function turn(said: string) {
		if (!active) return;
		const carried = continuing;
		continuing = null;
		if (!said && carried === null) return listen();
		// Going on from a message whose reply was cut off: both parts, as one message.
		const text = carried === null ? said : said ? `${carried} ${said}` : carried;
		lastHeard = text;
		answering = true;
		streamingReply = true;
		before = latest?.id ?? null;
		sawBusy = false;
		consumed = 0;
		speaker.begin(() => listen());
		listener.hold(true);
		const sent = await (carried === null ? options.send(text) : options.revise(text));
		if (!sent && active) {
			speaker.stop();
			listen();
		}
	}

	/**
	 * The reply stops and the user's next turn is listened to. When they started
	 * talking (`goingOn`) before any of the reply was heard, they're taken to be
	 * finishing their own message: the next turn is added to it (see continuing).
	 */
	function cutOff(goingOn = false) {
		if (!active || !answering) return;
		if (goingOn && streamingReply && !speaker.speaking) continuing = lastHeard;
		speaker.stop();
		if (streamingReply) options.interrupt();
		listen();
	}

	/**
	 * Follows the chat: the newest assistant message and whether a reply is being
	 * generated. Called whenever either changes.
	 */
	function observe(reply: VoiceReply, busy: boolean) {
		latest = reply;
		if (!active || !answering || !streamingReply) return;
		if (busy) sawBusy = true;
		const answer = reply && reply.id !== before ? reply : null;
		if (answer) {
			// The opening may start on a clause, so the voice comes in sooner.
			const part = speakableUpTo(
				answer.text,
				consumed,
				!busy,
				consumed === 0 ? FIRST_CLAUSE_CHARS : Infinity
			);
			consumed = part.next;
			if (part.text) speaker.push(part.text);
		}
		if ((answer || sawBusy) && !busy) {
			// Done, or it failed without a reply: whatever is queued is still read.
			streamingReply = false;
			speaker.end();
		}
	}

	/** The orb was tapped: ends the user's turn now, or skips the reply being read. */
	function tap() {
		if (!active) return;
		if (answering) cutOff();
		else listener.finishTurn();
	}

	return {
		get active() {
			return active;
		},
		get phase() {
			return phase;
		},
		get muted() {
			return listener.muted;
		},
		/** Live words from browser recognition while the user talks. */
		get interim() {
			return listener.interim;
		},
		get lastHeard() {
			return lastHeard;
		},
		readLevel: () => listener.readLevel(),
		start,
		stop,
		tap,
		observe,
		setMuted: (value: boolean) => listener.setMuted(value)
	};
}
