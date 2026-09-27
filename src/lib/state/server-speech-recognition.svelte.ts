import { browser } from '$app/environment';

interface MediaRecorderLike {
	start(timeslice?: number): void;
	stop(): void;
	state: string;
	ondataavailable: ((event: { data: Blob }) => void) | null;
	onerror: ((event: Event) => void) | null;
	onstop: (() => void) | null;
}

/**
 * Server-backed speech recognition. Records audio via MediaRecorder and sends
 * the full recording to the server-side transcription endpoint once when the
 * user stops or when the 120-second hard limit is reached.
 */
const MAX_RECORDING_DURATION = 120_000; // hard stop after 120s
const REQUEST_TIMEOUT = 30_000; // max time to wait for transcription response

export function createServerSpeechRecognition(sttModel: { providerId: string; modelId: string }) {
	let recording = $state(false);
	let busy = $state(false);
	let finalTranscript = $state('');
	let interim = $state('');
	let errorMessage = $state<string | null>(null);
	const display: string = $derived(finalTranscript.trim());

	let mediaRecorder: MediaRecorderLike | null = null;
	let stream: MediaStream | null = null;
	let audioCtx: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let freqData = new Uint8Array(0);
	let chunks: Blob[] = [];
	let maxDurationTimer: ReturnType<typeof setTimeout> | undefined;
	const supported = $state(browser && !!navigator.mediaDevices?.getUserMedia);

	let mimeType = 'audio/webm';

	async function sendTranscribe(blob: Blob): Promise<string> {
		const formData = new FormData();
		formData.append('audio', blob, 'recording.webm');
		formData.append('providerId', sttModel.providerId);
		formData.append('modelId', sttModel.modelId);

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

		const res = await fetch('/api/speech/transcribe', {
			method: 'POST',
			credentials: 'include',
			body: formData,
			signal: controller.signal
		});

		clearTimeout(timeoutId);

		if (!res.ok) {
			const data = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(data?.error ?? `Transcription failed (${res.status})`);
		}

		const { text } = (await res.json()) as { text: string };
		return text;
	}

	async function start(options?: { onError?: (message: string) => void }) {
		if (!supported || recording) return;

		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			// Wire up AudioContext for real-time frequency data (live spectrogram)
			audioCtx = new AudioContext();
			const source = audioCtx.createMediaStreamSource(stream);
			analyser = audioCtx.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.7;
			source.connect(analyser);
			freqData = new Uint8Array(analyser.frequencyBinCount);
		} catch (e) {
			const msg =
				e instanceof DOMException && e.name === 'NotAllowedError'
					? 'Microphone access denied'
					: 'Failed to access microphone';
			options?.onError?.(msg);
			return;
		}

		finalTranscript = '';
		interim = '';
		chunks = [];
		errorMessage = null;

		mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
			? 'audio/webm;codecs=opus'
			: MediaRecorder.isTypeSupported('audio/webm')
				? 'audio/webm'
				: 'audio/mp4';

		mediaRecorder = new MediaRecorder(stream, { mimeType }) as unknown as MediaRecorderLike;
		mediaRecorder.ondataavailable = (event: { data: Blob }) => {
			if (event.data.size > 0) chunks.push(event.data);
		};

		mediaRecorder.onerror = () => {
			const msg = 'Recording error';
			errorMessage = msg;
			options?.onError?.(msg);
			teardown();
		};

		mediaRecorder.onstop = async () => {
			teardownStream();

			if (chunks.length === 0) {
				recording = false;
				busy = false;
				cleanupAudio();
				return;
			}

			busy = true;
			const blob = new Blob(chunks, { type: mimeType });
			chunks = [];

			try {
				const text = await sendTranscribe(blob);
				if (text) {
					finalTranscript = text;
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : 'Transcription failed';
				errorMessage = msg;
				options?.onError?.(msg);
			} finally {
				recording = false;
				busy = false;
				cleanupAudio();
			}
		};

		mediaRecorder.start();
		recording = true;
		busy = false;

		maxDurationTimer = setTimeout(() => {
			stop();
		}, MAX_RECORDING_DURATION);
	}

	function teardownStream() {
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
			stream = null;
		}
		if (maxDurationTimer) {
			clearTimeout(maxDurationTimer);
			maxDurationTimer = undefined;
		}
	}

	function readFrequencyData(): Uint8Array {
		if (analyser) {
			analyser.getByteFrequencyData(freqData);
		}
		return freqData;
	}

	function cleanupAudio() {
		if (audioCtx) {
			audioCtx.close().catch(() => {});
			audioCtx = null;
			analyser = null;
			freqData = new Uint8Array(0);
		}
	}

	function teardown() {
		recording = false;
		busy = false;
		teardownStream();
		cleanupAudio();
	}

	function stop() {
		if (mediaRecorder && mediaRecorder.state === 'recording') {
			recording = false;
			busy = true;
			mediaRecorder.stop();
		}
	}

	function reset() {
		finalTranscript = '';
		interim = '';
		errorMessage = null;
	}

	function destroy() {
		if (mediaRecorder && mediaRecorder.state === 'recording') {
			mediaRecorder.stop();
		}
		teardown();
	}

	return {
		get supported() {
			return supported;
		},
		get recording() {
			return recording;
		},
		get busy() {
			return busy;
		},
		readFrequencyData,
		get finalTranscript() {
			return finalTranscript;
		},
		get interim() {
			return interim;
		},
		get display() {
			return display;
		},
		get error() {
			return errorMessage;
		},
		start,
		stop,
		reset,
		destroy
	};
}