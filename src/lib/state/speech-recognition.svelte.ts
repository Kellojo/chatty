import { browser } from '$app/environment';

type SpeechRecognitionInstance = any;
type SpeechRecognitionEvent = any;

const _w: any = browser ? window : null;
const SpeechRecognitionImpl = _w?.SpeechRecognition ?? _w?.webkitSpeechRecognition;
const supported = !!SpeechRecognitionImpl;

if (browser && !supported) {
	console.warn('Speech recognition is not supported in this browser');
}

export function createSpeechRecognition() {
	let recording = $state(false);
	let finalTranscript = $state('');
	let interim = $state('');
	const display: string = $derived((finalTranscript + ' ' + interim).trim());

	let recognition: SpeechRecognitionInstance | null = null;

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
		interim = '';
		return message;
	}

	function onEnd() {
		recording = false;
		interim = '';
	}

	function start(options?: { onError?: (message: string) => void }) {
		if (!supported || recording) return;
		const r = new SpeechRecognitionImpl();
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
			r.start();
		} catch (e) {
			console.error('Speech recognition start failed:', e);
			recording = false;
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
			} catch {}
		}
	}

	return {
		supported,
		get recording() {
			return recording;
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
		destroy
	};
}
