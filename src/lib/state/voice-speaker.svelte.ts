import { browser } from '$app/environment';
import { PRIVATE_SPEECH, type SpeechPrivacy } from '$lib/private-speech.js';
import { speechChunks } from '$lib/speakable-text.js';
import {
	fetchSpeech,
	NO_PRIVATE_VOICE,
	privateBrowserVoice,
	utteranceLang
} from './speech-playback.svelte.js';
import { voicePlayers } from './voice-audio.js';

/** The first piece is kept short so the voice starts quickly; later ones batch up. */
const FIRST_CHUNK = 200;
/**
 * Later batches grow gradually: a big one takes long to synthesize, and the
 * one playing must not run out before it arrives.
 */
const CHUNK_LIMITS = [FIRST_CHUNK, 300, 600];
/** Batches synthesized ahead of the one playing. */
const AHEAD = 2;

export type VoiceSpeaker = ReturnType<typeof createVoiceSpeaker>;

/**
 * Reads a reply aloud while it is still arriving. Text is pushed as sentences
 * complete; with the Text to speech default set, each batch is synthesized one
 * ahead of playback, otherwise the browser's voice reads it.
 *
 * `privacy` is the chat being read (default: private): the server only reads
 * a private chat with trusted models, the browser only with on-device voices.
 */
export function createVoiceSpeaker(options: {
	serverTts: () => boolean;
	privacy?: () => SpeechPrivacy;
	volume: () => number;
	onerror?: (message: string) => void;
	/** Audio started playing (for the first time in this reply). */
	onplaying?: () => void;
}) {
	/** Audio is coming out of the speakers. */
	let speaking = $state(false);
	/** Sentences waiting to be synthesized or spoken. */
	let pending: string[] = [];
	/** No more text will come for this reply. */
	let ended = false;
	let running = false;
	/** Utterances the browser voice still has to finish. */
	let utterances = 0;
	let generation = 0;
	let wake: (() => void) | null = null;
	let ondone: (() => void) | null = null;
	let controller: AbortController | null = null;
	/** Object URLs of fetched audio, revoked once played or on stop. */
	const urls: string[] = [];

	const volume = () => Math.min(1, Math.max(0, options.volume()));
	const browserVoice = () => browser && 'speechSynthesis' in window;
	const privacy = () => options.privacy?.() ?? PRIVATE_SPEECH;

	function started() {
		if (speaking) return;
		speaking = true;
		options.onplaying?.();
	}

	/** Starts a new reply; `done` runs once all of it has been spoken (not after stop()). */
	function begin(done: () => void) {
		stop();
		ondone = done;
	}

	/** Adds speakable text to the reply. */
	function push(text: string) {
		const pieces = speechChunks(text, FIRST_CHUNK);
		if (pieces.length === 0) return;
		if (options.serverTts()) {
			pending.push(...pieces);
			if (!running) void runServer(generation);
			wake?.();
		} else if (browserVoice()) {
			const isPrivate = privacy().private;
			const voice = isPrivate ? privateBrowserVoice(utteranceLang()) : null;
			if (isPrivate && !voice) return fail(generation, NO_PRIVATE_VOICE);
			for (const piece of pieces) speakBrowser(piece, generation, voice);
		} else {
			fail(generation, 'Reading aloud is not available in this browser');
		}
	}

	/** No more text is coming: done fires once what's queued has been spoken. */
	function end() {
		ended = true;
		wake?.();
		if (!running && utterances === 0) finish(generation);
	}

	function stop() {
		generation++;
		controller?.abort();
		controller = null;
		for (const el of voicePlayers()) {
			el.onended = null;
			el.onerror = null;
			el.onplaying = null;
			el.pause();
		}
		for (const url of urls.splice(0)) URL.revokeObjectURL(url);
		if (utterances > 0 && browserVoice()) window.speechSynthesis.cancel();
		utterances = 0;
		pending = [];
		ended = false;
		running = false;
		speaking = false;
		wake = null;
		ondone = null;
	}

	function finish(gen: number) {
		if (gen !== generation) return;
		const done = ondone;
		stop();
		done?.();
	}

	function fail(gen: number, message: string) {
		if (gen !== generation) return;
		options.onerror?.(message);
		finish(gen);
	}

	/** The next batch of text to synthesize, waiting for more if the reply is still coming. */
	async function next(gen: number, max: number): Promise<string | null> {
		while (pending.length === 0) {
			if (ended) return null;
			await new Promise<void>((resolve) => (wake = resolve));
			wake = null;
			if (gen !== generation) return null;
		}
		let text = pending.shift()!;
		while (pending.length > 0 && text.length + 1 + pending[0].length <= max) {
			text += ' ' + pending.shift();
		}
		return text;
	}

	function play(el: HTMLAudioElement, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return resolve();
			signal.addEventListener('abort', () => resolve(), { once: true });
			el.onplaying = started;
			el.onended = () => resolve();
			el.onerror = () => reject(new Error('Could not play the audio'));
			el.volume = volume();
			el.play().catch((e: unknown) => {
				reject(
					e instanceof DOMException && e.name === 'NotAllowedError'
						? new Error('Your browser blocked playback. Tap the orb to try again.')
						: e
				);
			});
		});
	}

	async function runServer(gen: number) {
		running = true;
		controller = new AbortController();
		const { signal } = controller;
		const players = voicePlayers();
		/** Each batch's playback, settling once it has finished playing. */
		const played: Promise<void>[] = [];
		try {
			for (let i = 0; ; i++) {
				// AHEAD batches ahead: the one AHEAD + 1 back must be done, freeing its element.
				if (i > AHEAD) await played[i - AHEAD - 1];
				if (gen !== generation) return;
				const text = await next(gen, CHUNK_LIMITS[i] ?? CHUNK_LIMITS.at(-1)!);
				if (gen !== generation) return;
				if (text === null) break;
				const el = players[i % players.length];
				const audio = fetchSpeech(text, signal, undefined, privacy());
				const before = played[i - 1] ?? Promise.resolve();
				const playback = (async () => {
					const url = await audio;
					urls.push(url);
					// Loads into an idle element while an earlier batch is still playing.
					if (gen !== generation) return;
					el.preload = 'auto';
					el.src = url;
					el.load();
					await before;
					if (gen !== generation) return;
					await play(el, signal);
					URL.revokeObjectURL(url);
					urls.splice(urls.indexOf(url), 1);
				})();
				// Reported as soon as it happens, not only once the loop gets to it.
				playback.catch((e: unknown) => {
					if (!signal.aborted) fail(gen, e instanceof Error ? e.message : 'Speech failed');
				});
				played.push(playback);
			}
			await played.at(-1);
			finish(gen);
		} catch (e) {
			if (gen !== generation || signal.aborted) return;
			fail(gen, e instanceof Error ? e.message : 'Speech failed');
		}
	}

	function speakBrowser(text: string, gen: number, voice: SpeechSynthesisVoice | null) {
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.lang = utteranceLang();
		if (voice) utterance.voice = voice;
		utterance.volume = volume();
		utterance.onstart = () => {
			if (gen === generation) started();
		};
		utterance.onend = () => {
			if (gen !== generation) return;
			utterances--;
			if (utterances === 0 && ended) finish(gen);
		};
		utterance.onerror = (event) => {
			if (event.error === 'interrupted' || event.error === 'canceled') return;
			fail(gen, 'Your browser could not read this aloud');
		};
		utterances++;
		window.speechSynthesis.speak(utterance);
	}

	return {
		get speaking() {
			return speaking;
		},
		begin,
		push,
		end,
		stop
	};
}
