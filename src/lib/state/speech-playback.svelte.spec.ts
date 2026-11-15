import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpeechPlayback } from './speech-playback.svelte.js';

/** Stands in for HTMLAudioElement: plays instantly, ends when the test says so. */
class FakeAudio {
	static all: FakeAudio[] = [];
	src = '';
	preload = '';
	volume = 1;
	/** What each play() call played. */
	sources: string[] = [];
	onplaying: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor() {
		FakeAudio.all.push(this);
	}
	load() {}
	play() {
		this.sources.push(this.src);
		if (!this.src.startsWith('data:')) queueMicrotask(() => this.onplaying?.());
		return Promise.resolve();
	}
	pause() {}
	end() {
		this.onended?.();
	}
}

const flush = () => new Promise((r) => setTimeout(r, 30));

let bodies: string[] = [];
let voices: (string | undefined)[] = [];
let signals: AbortSignal[] = [];

beforeEach(() => {
	bodies = [];
	voices = [];
	signals = [];
	FakeAudio.all = [];
	vi.stubGlobal('Audio', FakeAudio);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as { text: string; voice?: string };
			bodies.push(body.text);
			voices.push(body.voice);
			signals.push(init.signal!);
			return new Response(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }));
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function setup(volume = 1) {
	const onerror = vi.fn();
	const oninfo = vi.fn();
	const playback = createSpeechPlayback({
		serverTts: () => true,
		onerror,
		oninfo,
		volume: () => volume
	});
	return { playback, onerror, oninfo };
}

describe('createSpeechPlayback (server voice)', () => {
	it('plays chunks in turn on alternating elements, loading one ahead, then resets', async () => {
		const { playback, onerror } = setup();
		const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1}.`).join(
			' '
		);
		playback.toggle('m1', long);
		expect(playback.activeId).toBe('m1');
		expect(playback.loading).toBe(true);
		await flush();
		const [a, b] = FakeAudio.all;
		expect(FakeAudio.all).toHaveLength(2);
		// Both unlocked with silence during the click; the first chunk plays on `a`.
		expect(a.sources[0]).toMatch(/^data:audio\/wav/);
		expect(b.sources[0]).toMatch(/^data:audio\/wav/);
		expect(a.sources).toHaveLength(2);
		expect(playback.loading).toBe(false);
		// The second chunk is already loaded into `b`.
		expect(b.src).toMatch(/^blob:/);
		expect(b.preload).toBe('auto');
		// The second chunk is already on its way while the first plays.
		expect(bodies).toHaveLength(2);
		expect(bodies[0].length).toBeLessThanOrEqual(200);
		expect(bodies.join(' ')).toBe(long);

		a.end();
		await flush();
		expect(b.sources).toHaveLength(2);
		// It was ready, so no spinner between chunks.
		expect(playback.loading).toBe(false);
		b.end();
		await flush();
		expect(playback.activeId).toBeNull();
		expect(onerror).not.toHaveBeenCalled();
	});

	it('stops cleanly while audio is still loading', async () => {
		const { playback, onerror } = setup();
		playback.toggle('m1', 'Hello there.');
		playback.stop();
		await flush();
		expect(playback.activeId).toBeNull();
		expect(playback.loading).toBe(false);
		expect(signals[0].aborted).toBe(true);
		expect(onerror).not.toHaveBeenCalled();
	});

	it('toggling the same message stops it; another message takes over', async () => {
		const { playback } = setup();
		playback.toggle('m1', 'One.');
		await flush();
		playback.toggle('m2', 'Two.');
		expect(playback.activeId).toBe('m2');
		expect(signals[0].aborted).toBe(true);
		playback.toggle('m2', 'Two.');
		expect(playback.activeId).toBeNull();
	});

	it('reports a failed request and resets', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ message: 'No text to speech model is set' }, { status: 409 })
			)
		);
		const { playback, onerror } = setup();
		playback.toggle('m1', 'Hello.');
		await flush();
		expect(onerror).toHaveBeenCalledWith('No text to speech model is set');
		expect(playback.activeId).toBeNull();
	});

	it('says when there is nothing to read', () => {
		const { playback, onerror } = setup();
		playback.toggle('m1', '```js\nconst x = 1;\n```');
		expect(onerror).toHaveBeenCalledWith('Nothing to read aloud');
		expect(playback.activeId).toBeNull();
	});

	it('notes when only the start of a very long reply is read', () => {
		const { playback, oninfo } = setup();
		playback.toggle('m1', 'A short sentence here. '.repeat(1200));
		expect(oninfo).toHaveBeenCalledOnce();
		playback.stop();
	});

	it('plays at the configured volume', async () => {
		const { playback } = setup(0.3);
		playback.toggle('m1', 'Quietly now.');
		await flush();
		expect(FakeAudio.all[0].volume).toBe(0.3);
		playback.stop();
	});

	it('previews a voice: sends it with the text, and play() replaces what is playing', async () => {
		const { playback } = setup();
		playback.play('preview', 'Hi, I am af_bella.', 'af_bella');
		await flush();
		playback.play('preview', 'Hi, I am am_adam.', 'am_adam');
		await flush();
		expect(playback.activeId).toBe('preview');
		expect(signals[0].aborted).toBe(true);
		expect(voices).toEqual(['af_bella', 'am_adam']);
		// A normal read goes back to the configured voice.
		playback.toggle('m1', 'Back to normal.');
		await flush();
		expect(voices.at(-1)).toBeUndefined();
		playback.stop();
	});
});
