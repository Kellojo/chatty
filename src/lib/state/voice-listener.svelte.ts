import {
	BARGE_IN_DETECTION,
	rms,
	soundsFinished,
	TURN_DETECTION,
	VoiceActivity
} from '$lib/voice-activity.js';
import {
	canUseBrowserRecognition,
	PRIVATE_MIC_HINT,
	PRIVATE_SPEECH,
	type SpeechPrivacy
} from '$lib/private-speech.js';
import { recordingMimeType, transcribeRecording } from './server-speech-recognition.svelte.js';
import { voiceAudioContext } from './voice-audio.js';

/** How often the microphone level is measured. */
const TICK_MS = 30;
/** A turn is sent once it runs this long, even if the speaker hasn't paused. */
const MAX_TURN_MS = 120_000;
/** Silence recorded before anyone speaks is dropped after this long, to keep uploads small. */
const MAX_IDLE_RECORDING_MS = 10_000;
/**
 * After a pause ends what was said so far (it is transcribed meanwhile), how
 * much longer the turn waits before it is sent: talking again within this
 * time carries on the same turn. A transcript that sounds finished (see
 * soundsFinished) is sent as soon as it arrives instead.
 */
const SETTLE_MS = 700;
/** Browser recognition: how long its final words get to arrive before they're judged. */
const BROWSER_FINISH_MS = 150;

type Recognition = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: RecognitionEvent) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
};
type RecognitionEvent = {
	resultIndex: number;
	results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

function recognitionCtor(): (new () => Recognition) | null {
	if (typeof window === 'undefined') return null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = window as any;
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Voice mode can hear the user: a microphone plus server or browser speech to
 * text. A private chat never uses the browser's recognition (it sends the
 * audio to Google); `isPrivate` defaults to true.
 */
export function canListen(sttModel: unknown, isPrivate = true): boolean {
	if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
	if (sttModel) return typeof MediaRecorder !== 'undefined';
	return canUseBrowserRecognition(isPrivate) && recognitionCtor() !== null;
}

/** Dev builds log what voice mode hears, to tune detection by. */
function debug(message: string) {
	if (import.meta.env.DEV) console.info(`[voice] ${message}`);
}

export type VoiceListener = ReturnType<typeof createVoiceListener>;

/**
 * The microphone side of voice mode. Keeps the microphone open for the whole
 * conversation; while listening it hears when the user starts and stops
 * talking and turns what they said into text (with the Speech to text default,
 * or the browser's recognition). While the assistant talks it only watches for
 * the user talking over it.
 */
export function createVoiceListener(options: {
	sttModel: { providerId: string; modelId: string } | null;
	/**
	 * The chat voice mode talks in (default: private). Sent with each
	 * transcription; a private chat never uses browser recognition.
	 */
	privacy?: () => SpeechPrivacy;
	/** What the user said in one turn; empty when nothing was understood. */
	onturn: (text: string) => void;
	/** The user started talking while the assistant was busy. */
	onbargein: () => void;
	onerror: (message: string) => void;
	/** Listening can't go on (recognition keeps failing); voice mode should end. */
	onfatal: () => void;
}) {
	/** The user is talking (in a turn being listened to). */
	let hearing = $state(false);
	let transcribing = $state(false);
	let muted = $state(false);
	/** What browser recognition has made out so far. */
	let interim = $state('');

	let mode: 'off' | 'idle' | 'turn' | 'barge' = 'off';
	let stream: MediaStream | null = null;
	let source: MediaStreamAudioSourceNode | null = null;
	let analyser: AnalyserNode | null = null;
	let samples: Float32Array<ArrayBuffer> = new Float32Array(0);
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastTick = 0;
	/** When the microphone level was last logged (see debug). */
	let lastDebug = 0;
	let level = 0;
	const turnVad = new VoiceActivity(TURN_DETECTION);
	let bargeVad = new VoiceActivity(BARGE_IN_DETECTION);
	let turnStartedAt = 0;
	let captureStartedAt = 0;
	/** The user paused: the turn is sent once the pause has lasted SETTLE_MS longer. */
	let settling = false;
	let pausedAt = 0;
	/** Counts pauses and resumes, so a transcript arriving late judges only its own pause. */
	let pauseSeq = 0;
	/**
	 * The turn is being sent (its last parts are still transcribing). Talking
	 * again meanwhile takes it back and the turn goes on.
	 */
	let committing = false;
	/** Bumped when a send is taken back, so its transcripts arriving late are dropped. */
	let commitSeq = 0;

	// Server speech to text: the turn is recorded and transcribed once it ends.
	let recorder: MediaRecorder | null = null;
	/** The current recording's data. */
	let chunks: Blob[] = [];
	/** Transcripts of this turn's finished parts (split at pauses), in order. */
	let segments: Promise<string>[] = [];
	/** Cancels this turn's transcriptions when voice mode closes. */
	let transcription: AbortController | null = null;

	// Browser speech to text: recognition runs through the turn.
	let recognition: Recognition | null = null;
	let recognized = '';
	/** Turn ended; recognition is stopping and delivers its text on end. */
	let recognitionClosing = false;
	/** Recognition sessions in a row that ended right after starting. */
	let quickEnds = 0;

	const privacy = () => options.privacy?.() ?? PRIVATE_SPEECH;
	const browserRecognitionAllowed = () => canUseBrowserRecognition(privacy().private);

	async function open(): Promise<boolean> {
		if (mode !== 'off') return true;
		if (!options.sttModel && !browserRecognitionAllowed()) {
			options.onerror(PRIVATE_MIC_HINT);
			return false;
		}
		// The AudioContext first, while the click still counts (see voice-audio.ts).
		const ctx = voiceAudioContext();
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
			});
		} catch (e) {
			options.onerror(
				e instanceof DOMException && e.name === 'NotAllowedError'
					? 'Microphone access denied'
					: 'Failed to access the microphone'
			);
			return false;
		}
		source = ctx.createMediaStreamSource(stream);
		analyser = ctx.createAnalyser();
		analyser.fftSize = 1024;
		source.connect(analyser);
		samples = new Float32Array(analyser.fftSize);
		const track = stream.getAudioTracks()[0];
		debug(
			`microphone open: ${track?.label || 'unknown device'}, ${track?.readyState}, audio ${ctx.state}, ${options.sttModel ? 'server' : 'browser'} speech to text`
		);
		mode = 'idle';
		muted = false;
		lastTick = performance.now();
		timer = setInterval(tick, TICK_MS);
		return true;
	}

	function close() {
		mode = 'off';
		clearInterval(timer);
		stopCapture();
		transcription?.abort();
		transcription = null;
		segments = [];
		settling = false;
		committing = false;
		commitSeq++;
		source?.disconnect();
		source = null;
		analyser = null;
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		level = 0;
		hearing = false;
		transcribing = false;
		interim = '';
	}

	function tick() {
		const now = performance.now();
		const dt = Math.min(500, now - lastTick);
		lastTick = now;
		if (!analyser || muted) {
			level = 0;
			return;
		}
		// Suspended audio measures as silence; it may only resume once the page is used.
		if (analyser.context.state === 'suspended') void (analyser.context as AudioContext).resume();
		analyser.getFloatTimeDomainData(samples);
		level = rms(samples);
		if (now - lastDebug > 1000) {
			lastDebug = now;
			debug(
				`${mode} level=${level.toFixed(4)} threshold=${turnVad.threshold.toFixed(4)} hearing=${hearing} audio=${analyser.context.state}`
			);
		}

		if (mode === 'turn') {
			const event = turnVad.update(level, dt);
			if (event) debug(`speech ${event}`);
			if (event === 'start') {
				// Talking again after a pause carries on the same turn.
				if (!hearing) turnStartedAt = now;
				hearing = true;
				settling = false;
				pauseSeq++;
				if (committing) {
					debug('talking again: the turn goes on');
					committing = false;
					transcribing = false;
					commitSeq++;
				}
			} else if (event === 'end') {
				pause(now);
			} else if (event === 'blip') {
				// A noise: if something was said before it, the pause goes on; else nothing happened.
				if (settling || segments.length > 0 || recognized || interim) {
					settling = true;
					pausedAt = now;
				} else {
					hearing = false;
				}
			} else if (
				settling &&
				!options.sttModel &&
				!turnVad.speaking &&
				now - pausedAt >= BROWSER_FINISH_MS &&
				soundsFinished(recognized)
			) {
				debug('sounds finished: sending early');
				endTurn();
			} else if (settling && !turnVad.speaking && now - pausedAt >= SETTLE_MS) {
				endTurn();
			} else if (hearing && now - turnStartedAt > MAX_TURN_MS) {
				endTurn();
			} else if (!hearing && recorder && now - captureStartedAt > MAX_IDLE_RECORDING_MS) {
				startCapture();
			}
		} else if (mode === 'barge') {
			if (bargeVad.update(level, dt) === 'start') {
				mode = 'idle';
				options.onbargein();
			}
		}
	}

	/** Listens for the user's next turn. */
	function listen() {
		if (mode === 'off') return;
		mode = 'turn';
		turnVad.reset();
		hearing = false;
		settling = false;
		committing = false;
		transcribing = false;
		commitSeq++;
		interim = '';
		segments = [];
		transcription?.abort();
		transcription = new AbortController();
		startCapture();
	}

	/**
	 * Stops listening while the assistant answers. With `bargeIn`, the user
	 * talking over it is reported (see onbargein).
	 */
	function hold(bargeIn: boolean) {
		if (mode === 'off') return;
		stopCapture();
		hearing = false;
		settling = false;
		committing = false;
		transcribing = false;
		commitSeq++;
		mode = bargeIn ? 'barge' : 'idle';
		if (bargeIn) rearmBargeIn();
	}

	/** Learns the room afresh, e.g. once the assistant's voice can be heard in it. */
	function rearmBargeIn() {
		bargeVad = new VoiceActivity(BARGE_IN_DETECTION);
	}

	/**
	 * Ends the turn now, as if the user had paused. Also when no speech was
	 * detected (a quiet microphone): the user says they're done.
	 */
	function finishTurn() {
		if (mode !== 'turn' || committing) return;
		const recording = recorder !== null && performance.now() - captureStartedAt > 800;
		if (hearing || recognized || interim || recording) endTurn();
	}

	function setMuted(value: boolean) {
		muted = value;
		for (const track of stream?.getAudioTracks() ?? []) track.enabled = !value;
		if (value && mode === 'turn') {
			// Whatever was half said is dropped; listening starts over on unmute.
			hearing = false;
			settling = false;
			committing = false;
			transcribing = false;
			commitSeq++;
			segments = [];
			stopCapture();
		} else if (!value && mode === 'turn') {
			listen();
		}
	}

	function startCapture() {
		stopCapture();
		captureStartedAt = performance.now();
		if (options.sttModel) startRecorder();
		else startRecognition();
	}

	function stopCapture() {
		if (recorder) {
			recorder.onstop = null;
			if (recorder.state !== 'inactive') recorder.stop();
			recorder = null;
		}
		chunks = [];
		if (recognition) {
			recognition.onend = null;
			recognition.onresult = null;
			recognition.onerror = null;
			recognition.abort();
			recognition = null;
		}
		recognized = '';
		recognitionClosing = false;
	}

	/**
	 * The user paused. What they said so far is transcribed right away, while a
	 * new recording catches them if they go on (see SETTLE_MS).
	 */
	function pause(now: number) {
		settling = true;
		pausedAt = now;
		const seq = ++pauseSeq;
		if (recorder) {
			cutSegment();
			startRecorder();
			// Sounds finished once transcribed: send without waiting out the settle time.
			const parts = segments.slice();
			void Promise.all(parts).then((texts) => {
				if (mode !== 'turn' || !settling || seq !== pauseSeq || turnVad.speaking) return;
				if (!soundsFinished(texts.filter(Boolean).join(' '))) return;
				debug('sounds finished: sending early');
				endTurn();
			});
		}
		// Browser recognition simply keeps running through the pause (see tick).
	}

	/** Stops the current recording and queues its transcription as part of the turn. */
	function cutSegment() {
		const rec = recorder;
		if (!rec) return;
		recorder = null;
		const parts = chunks;
		segments.push(
			new Promise<Blob>((resolve) => {
				rec.onstop = () => resolve(new Blob(parts, { type: rec.mimeType }));
				rec.stop();
			}).then(transcribeSegment)
		);
	}

	/**
	 * Sends the turn: everything said in it, joined. With server speech to text
	 * the microphone keeps recording until the text is ready, so the user can
	 * still go on (see committing).
	 */
	function endTurn() {
		const paused = settling;
		hearing = false;
		settling = false;
		if (options.sttModel) {
			// After a pause the running recording holds only the pause: it goes on, in case
			// the user does. Otherwise what was said is cut off here and a new one starts.
			if (!paused) {
				cutSegment();
				startRecorder();
			}
			void deliver();
			return;
		}
		mode = 'idle';
		if (recognition) {
			recognitionClosing = true;
			recognition.stop();
		} else {
			options.onturn('');
		}
	}

	async function deliver() {
		const parts = segments.slice();
		const signal = transcription?.signal;
		const seq = ++commitSeq;
		committing = true;
		transcribing = true;
		const texts = await Promise.all(parts);
		// Taken back (the user went on), or voice mode moved on meanwhile.
		if (seq !== commitSeq || signal?.aborted || mode !== 'turn') return;
		committing = false;
		transcribing = false;
		mode = 'idle';
		segments = [];
		stopCapture();
		options.onturn(texts.filter(Boolean).join(' '));
	}

	function startRecorder() {
		if (!stream) return;
		// Its own buffer: the last data of a stopped recording arrives after the next one started.
		const parts: Blob[] = [];
		const rec = new MediaRecorder(stream, { mimeType: recordingMimeType() });
		rec.ondataavailable = (event) => {
			if (event.data.size > 0) parts.push(event.data);
		};
		rec.start();
		recorder = rec;
		chunks = parts;
	}

	/** One part of the turn as text; empty if it couldn't be transcribed (reported once). */
	async function transcribeSegment(blob: Blob): Promise<string> {
		if (!options.sttModel || mode === 'off') return '';
		const signal = transcription?.signal;
		debug(`transcribing ${Math.round(blob.size / 1024)} KB of ${blob.type}`);
		try {
			const text = (await transcribeRecording(blob, options.sttModel, signal, privacy())).trim();
			debug(`transcript: "${text}"`);
			return text;
		} catch (e) {
			if (!signal?.aborted) {
				options.onerror(e instanceof Error ? e.message : 'Transcription failed');
			}
			return '';
		}
	}

	function startRecognition() {
		// The chat may have turned private since voice mode opened.
		if (!browserRecognitionAllowed()) {
			options.onerror(PRIVATE_MIC_HINT);
			options.onfatal();
			return;
		}
		const Ctor = recognitionCtor();
		if (!Ctor) return;
		const r = new Ctor();
		// Continuous, so our own pause detection decides when a turn ends.
		r.continuous = true;
		r.interimResults = true;
		r.lang = navigator.language ?? 'en';
		recognized = '';
		const startedAt = performance.now();
		r.onresult = (event) => {
			let pendingText = '';
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				if (result.isFinal) recognized = `${recognized} ${result[0].transcript}`.trim();
				else pendingText += result[0].transcript;
			}
			interim = `${recognized} ${pendingText}`.trim();
		};
		r.onerror = (event) => {
			if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
				options.onerror('Microphone access denied');
				options.onfatal();
			} else if (event.error === 'network') {
				options.onerror('Speech recognition network error');
			}
			// 'no-speech' and 'aborted' just end the session; onend picks up from there.
		};
		r.onend = () => {
			if (recognition !== r) return;
			const text = (recognized || interim).trim();
			recognition = null;
			if (recognitionClosing) {
				recognitionClosing = false;
				recognized = '';
				options.onturn(text);
			} else if (mode === 'turn') {
				// The browser ended the session on its own (a long silence): keep listening.
				if (text) {
					mode = 'idle';
					hearing = false;
					options.onturn(text);
				} else {
					quickEnds = performance.now() - startedAt < 1000 ? quickEnds + 1 : 0;
					if (quickEnds < 3) return startRecognition();
					quickEnds = 0;
					options.onerror('Speech recognition stopped working');
					options.onfatal();
				}
			}
		};
		recognition = r;
		try {
			r.start();
		} catch {
			recognition = null;
		}
	}

	return {
		get hearing() {
			return hearing;
		},
		get transcribing() {
			return transcribing;
		},
		get muted() {
			return muted;
		},
		get interim() {
			return interim;
		},
		/** The microphone's current loudness (RMS, 0–1). */
		readLevel() {
			return level;
		},
		open,
		close,
		listen,
		hold,
		rearmBargeIn,
		finishTurn,
		setMuted
	};
}
