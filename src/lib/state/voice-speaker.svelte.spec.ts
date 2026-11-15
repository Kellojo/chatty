import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSpeaker } from './voice-speaker.svelte.js';
import { voicePlayers } from './voice-audio.js';

/** Stands in for HTMLAudioElement: plays instantly, ends when the test says so. */
class FakeAudio {
	src = '';
	preload = '';
	volume = 1;
	/** What each play() call played. */
	sources: string[] = [];
	onplaying: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	load() {}
	play() {
		this.sources.push(this.src);
		queueMicrotask(() => this.onplaying?.());
		return Promise.resolve();
	}
	pause() {}
	end() {
		this.onended?.();
	}
}

const flush = () => new Promise((r) => setTimeout(r, 30));

let bodies: string[] = [];
let signals: AbortSignal[] = [];

beforeEach(() => {
	bodies = [];
	signals = [];
	vi.stubGlobal('Audio', FakeAudio);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			bodies.push((JSON.parse(String(init.body)) as { text: string }).text);
			signals.push(init.signal!);
			return new Response(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }));
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function setup() {
	const onerror = vi.fn();
	const onplaying = vi.fn();
	const speaker = createVoiceSpeaker({
		serverTts: () => true,
		volume: () => 1,
		onerror,
		onplaying
	});
	// Created once and shared across speakers (see voice-audio.ts).
	const [a, b, c] = voicePlayers() as unknown as [FakeAudio, FakeAudio, FakeAudio];
	for (const el of [a, b, c]) el.sources = [];
	return { speaker, onerror, onplaying, a, b, c };
}

describe('createVoiceSpeaker (server voice)', () => {
	it('speaks text as it arrives, two batches ahead, then finishes', async () => {
		const { speaker, onerror, onplaying, a, b, c } = setup();
		const done = vi.fn();
		speaker.begin(done);
		speaker.push('Hello there.');
		await flush();
		expect(bodies).toEqual(['Hello there.']);
		expect(speaker.speaking).toBe(true);
		expect(onplaying).toHaveBeenCalledOnce();

		// The next ones are fetched right away, up to two ahead of playback;
		// sentences arriving together go out as one batch.
		speaker.push('How are you?');
		await flush();
		speaker.push('I am fine.');
		speaker.push('Thanks for asking.');
		speaker.push('Shall we go?');
		speaker.end();
		await flush();
		expect(bodies).toEqual([
			'Hello there.',
			'How are you?',
			'I am fine. Thanks for asking. Shall we go?'
		]);
		// They wait their turn on their own elements.
		expect(b.sources).toHaveLength(0);
		expect(c.sources).toHaveLength(0);

		a.end();
		await flush();
		expect(b.sources).toHaveLength(1);
		b.end();
		await flush();
		expect(c.sources).toHaveLength(1);
		expect(done).not.toHaveBeenCalled();
		c.end();
		await flush();
		expect(done).toHaveBeenCalledOnce();
		expect(speaker.speaking).toBe(false);
		expect(onerror).not.toHaveBeenCalled();
	});

	it('waits for a batch to finish before fetching a third ahead', async () => {
		const { speaker, a } = setup();
		speaker.begin(() => {});
		for (const s of ['One.', 'Two.', 'Three.', 'Four.']) {
			speaker.push(s);
			await flush();
		}
		expect(bodies).toEqual(['One.', 'Two.', 'Three.']);
		a.end();
		await flush();
		expect(bodies).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
		speaker.stop();
	});

	it('finishes at once when the reply had nothing to say', () => {
		const { speaker } = setup();
		const done = vi.fn();
		speaker.begin(done);
		speaker.end();
		expect(done).toHaveBeenCalledOnce();
	});

	it('stops without finishing', async () => {
		const { speaker } = setup();
		const done = vi.fn();
		speaker.begin(done);
		speaker.push('Hello there.');
		await flush();
		speaker.push('More to come.');
		speaker.stop();
		await flush();
		expect(signals.length).toBeGreaterThan(0);
		expect(signals.every((s) => s.aborted)).toBe(true);
		expect(done).not.toHaveBeenCalled();
		expect(speaker.speaking).toBe(false);
	});

	it('reports a failed request and finishes so listening can go on', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ message: 'Speech failed' }, { status: 502 }))
		);
		const { speaker, onerror } = setup();
		const done = vi.fn();
		speaker.begin(done);
		speaker.push('Hello.');
		await flush();
		expect(onerror).toHaveBeenCalledWith('Speech failed');
		expect(done).toHaveBeenCalledOnce();
	});
});
