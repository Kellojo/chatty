import { browser } from '$app/environment';
import { canUseBrowserRecognition } from '$lib/private-speech.js';

interface SpeechRecognitionAlternative {
	transcript: string;
}

interface SpeechRecognitionResult {
	readonly isFinal: boolean;
	readonly [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionEvent {
	readonly error?: string;
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResult[];
}

type SpeechRecognitionInstance = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onerror: ((event: SpeechRecognitionEvent) => void) | null;
	onend: (() => void) | null;
	onresult: ((event: SpeechRecognitionEvent) => void) | null;
	start: () => void;
	stop: () => void;
	abort: () => void;
} | null;

type SpeechRecognitionCtor = new () => NonNullable<SpeechRecognitionInstance>;

/** The browser's recognition, looked up when needed (tests stub it). */
function recognitionCtor(): SpeechRecognitionCtor | null {
	if (!browser) return null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = window as any;
	return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null;
}

if (browser && !recognitionCtor()) {
	console.warn('Speech recognition is not supported in this browser');
}

/**
 * Dictation with the browser's own speech recognition. Never in a private
 * chat (`options.private`): Chrome sends the audio to Google, so a private
 * chat's recognition is reported unsupported and never constructed.
 */
export function createSpeechRecognition(
	options: {
		/** The chat is private (read on each start). Unset counts as private. */
		private?: () => boolean;
	} = {}
) {
	const allowed = () => canUseBrowserRecognition(options.private?.() ?? true);
	let recording = $state(false);
	let busy = $state(false);
	let finalTranscript = $state('');
	let interim = $state('');
	const display: string = $derived((finalTranscript + ' ' + interim).trim());

	let recognition: SpeechRecognitionInstance | null = null;
	let audioCtx: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let freqData = new Uint8Array(0);
	let freqStream: MediaStream | null = null;

	function onResult(event: SpeechRecognitionEvent) {
		let interimAccum = '';
		for (let i = event.resultIndex; i < event.results.length; i++) {
			const result = event.results[i];
			if (result.isFinal) {
				finalTranscript += ' ' + result[0].transcript;
			} else {
				interimAccum += result[0].transcript;
			}
		}
		interim = interimAccum.trim();
	}

	function cleanupAudio() {
		if (freqStream) {
			freqStream.getTracks().forEach((t) => t.stop());
			freqStream = null;
		}
		if (audioCtx) {
			audioCtx.close().catch(() => {});
			audioCtx = null;
			analyser = null;
			freqData = new Uint8Array(0);
		}
	}

	function onError(event: SpeechRecognitionEvent): string | undefined {
		const error = event.error;
		let message: string;
		if (error === 'not-allowed' || error === 'service-not-allowed') {
			message = 'Microphone access denied';
		} else if (error === 'no-speech') {
			message = 'No speech detected';
		} else if (error === 'network') {
			message = 'Speech recognition network error';
		} else {
			message = 'Speech recognition failed';
		}
		recording = false;
		busy = false;
		cleanupAudio();
		interim = '';
		return message;
	}

	function onEnd() {
		recording = false;
		busy = false;
		cleanupAudio();
		interim = '';
	}

	function readFrequencyData(): Uint8Array {
		if (analyser) {
			analyser.getByteFrequencyData(freqData);
		}
		return freqData;
	}

	async function start(options?: { onError?: (message: string) => void }) {
		const Ctor = recognitionCtor();
		if (!Ctor || !allowed() || recording) return;
		const r = new Ctor();
		r.continuous = true;
		r.interimResults = true;
		r.lang = navigator.language ?? 'en';

		recognition = r;
		finalTranscript = '';
		interim = '';

		r.onresult = onResult;
		const errHandler = (event: SpeechRecognitionEvent) => {
			const msg = onError(event);
			if (msg && options?.onError) {
				options.onError(msg);
			}
		};
		r.onerror = errHandler;
		r.onend = onEnd;

		try {
			recording = true;
			busy = true;

			// Open a parallel audio stream just for live waveform visualization.
			// Browser SpeechRecognition manages its own audio internally.
			try {
				freqStream = await navigator.mediaDevices.getUserMedia({ audio: true });
				audioCtx = new AudioContext();
				const source = audioCtx.createMediaStreamSource(freqStream);
				analyser = audioCtx.createAnalyser();
				analyser.fftSize = 256;
				analyser.smoothingTimeConstant = 0.7;
				source.connect(analyser);
				freqData = new Uint8Array(analyser.frequencyBinCount);
			} catch {
				// fine — waveform just won't render
			}

			r.start();
		} catch (e) {
			console.error('Speech recognition start failed:', e);
			recording = false;
			busy = false;
			cleanupAudio();
		}
	}

	function stop() {
		if (recognition && recording) {
			recognition.stop();
		}
	}

	function reset() {
		finalTranscript = '';
		interim = '';
	}

	function destroy() {
		if (recognition) {
			try {
				recognition.abort();
			} catch {
				// isolate already destroyed
			}
		}
		cleanupAudio();
	}

	return {
		get supported() {
			return recognitionCtor() !== null && allowed();
		},
		get recording() {
			return recording;
		},
		get busy() {
			return busy;
		},
		get finalTranscript() {
			return finalTranscript;
		},
		get interim() {
			return interim;
		},
		get display() {
			return display;
		},
		start,
		stop,
		reset,
		destroy,
		readFrequencyData
	};
}
