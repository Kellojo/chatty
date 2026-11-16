import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpeechRecognition } from './speech-recognition.svelte.js';
import { createSpeechPlayback, fetchSpeech } from './speech-playback.svelte.js';
import { canListen, createVoiceListener } from './voice-listener.svelte.js';
import { transcribeRecording } from './server-speech-recognition.svelte.js';

/** Counts constructions of the browser's speech recognition. */
const constructed = vi.fn();
class FakeRecognition {
	continuous = false;
	interimResults = false;
	lang = '';
	onresult = null;
	onerror = null;
	onend = null;
	constructor() {
		constructed();
	}
	start() {}
	stop() {}
	abort() {}
}

beforeEach(() => {
	constructed.mockClear();
	vi.stubGlobal('SpeechRecognition', FakeRecognition);
	vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
	// The waveform's microphone stream: refused, so no permission prompt is involved.
	vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(
		new DOMException('denied', 'NotAllowedError')
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('browser speech recognition in a private chat', () => {
	it('is never constructed when private, nor by default', async () => {
		const privateChat = createSpeechRecognition({ private: () => true });
		expect(privateChat.supported).toBe(false);
		await privateChat.start();
		const unspecified = createSpeechRecognition();
		await unspecified.start();
		expect(constructed).not.toHaveBeenCalled();

		// A public chat still uses it (so the stub above is what would be hit).
		const publicChat = createSpeechRecognition({ private: () => false });
		expect(publicChat.supported).toBe(true);
		await publicChat.start();
		expect(constructed).toHaveBeenCalledTimes(1);
		publicChat.destroy();
	});

	it('voice mode cannot listen with browser recognition in a private chat', async () => {
		expect(canListen(null, true)).toBe(false);
		expect(canListen(null, false)).toBe(true);
		const onerror = vi.fn();
		const listener = createVoiceListener({
			sttModel: null,
			privacy: () => ({ conversationId: 'c1', private: true }),
			onturn: vi.fn(),
			onbargein: vi.fn(),
			onerror,
			onfatal: vi.fn()
		});
		expect(await listener.open()).toBe(false);
		expect(onerror).toHaveBeenCalledWith(
			'Set a trusted speech-to-text model to dictate in private chats'
		);
		expect(constructed).not.toHaveBeenCalled();
	});
});

describe('speech requests carry the chat', () => {
	const sent: RequestInit[] = [];
	beforeEach(() => {
		sent.length = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				sent.push(init);
				return _url.includes('transcribe')
					? Response.json({ text: 'hi' })
					: new Response(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }));
			})
		);
	});

	it('synthesize sends the conversation id, or private by default', async () => {
		const signal = new AbortController().signal;
		await fetchSpeech('Hi', signal, undefined, { conversationId: 'c1', private: false });
		await fetchSpeech('Hi', signal);
		expect(sent.map((init) => JSON.parse(String(init.body)))).toEqual([
			{ text: 'Hi', conversationId: 'c1', private: false },
			{ text: 'Hi', private: true }
		]);
	});

	it('transcribe sends the conversation id, or private by default', async () => {
		const model = { providerId: 'p', modelId: 'm' };
		await transcribeRecording(new Blob([new Uint8Array([1])]), model, undefined, {
			private: false
		});
		await transcribeRecording(new Blob([new Uint8Array([1])]), model, undefined, {
			conversationId: 'c1',
			private: true
		});
		await transcribeRecording(new Blob([new Uint8Array([1])]), model);
		const fields = sent.map((init) => {
			const form = init.body as FormData;
			return { conversationId: form.get('conversationId'), private: form.get('private') };
		});
		expect(fields).toEqual([
			{ conversationId: null, private: 'false' },
			{ conversationId: 'c1', private: 'true' },
			{ conversationId: null, private: 'true' }
		]);
	});
});

describe('browser read-aloud in a private chat', () => {
	class FakeUtterance {
		voice: unknown = null;
		lang = '';
		volume = 1;
		onend: (() => void) | null = null;
		onerror: (() => void) | null = null;
		constructor(public text: string) {}
	}
	const voice = (name: string, localService: boolean) => ({
		name,
		lang: 'en-US',
		localService,
		default: false,
		voiceURI: name
	});
	let spoken: FakeUtterance[];
	let voices: ReturnType<typeof voice>[];

	beforeEach(() => {
		spoken = [];
		voices = [];
		vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
		vi.stubGlobal('speechSynthesis', {
			getVoices: () => voices,
			speak: (u: FakeUtterance) => spoken.push(u),
			cancel: () => {}
		});
	});

	const setup = () => {
		const onerror = vi.fn();
		const playback = createSpeechPlayback({
			serverTts: () => false,
			privacy: () => ({ conversationId: 'c1', private: true }),
			onerror
		});
		return { playback, onerror };
	};

	it('reads only with a voice that runs on the device', () => {
		voices = [voice('Cloud', false), voice('On device', true)];
		const { playback, onerror } = setup();
		expect(playback.supported).toBe(true);
		playback.play('m1', 'Hello there.');
		expect(onerror).not.toHaveBeenCalled();
		expect(spoken.length).toBeGreaterThan(0);
		expect(spoken.every((u) => (u.voice as { name: string }).name === 'On device')).toBe(true);
	});

	it('is not offered without an on-device voice', () => {
		voices = [voice('Cloud', false)];
		const { playback, onerror } = setup();
		expect(playback.supported).toBe(false);
		playback.play('m1', 'Hello there.');
		expect(spoken).toEqual([]);
		expect(onerror).toHaveBeenCalled();
	});
});
