import type { UIMessageChunk } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const unsubscribed = vi.hoisted(() => ({ count: 0 }));

vi.mock('./streams.js', async () => {
	const actual = await vi.importActual<typeof import('./streams.js')>('./streams.js');
	return {
		...actual,
		subscribeChunks: (id: string, listener: (chunk: UIMessageChunk) => void) => {
			const { unsubscribe } = actual.subscribeChunks(id, listener);
			return {
				unsubscribe: () => {
					unsubscribed.count++;
					unsubscribe();
				}
			};
		}
	};
});

const { appendChunk, markDone, registerStream, releaseStream } = await import('./streams.js');
const { createStreamReplayResponse } = await import('./replay.js');

const controllers: Array<[string, AbortController]> = [];

function startStream(id: string) {
	const controller = new AbortController();
	registerStream(id, controller);
	controllers.push([id, controller]);
	appendChunk(id, { type: 'start', messageId: 'm1' });
	return controller;
}

afterEach(() => {
	for (const [id, controller] of controllers.splice(0)) releaseStream(id, controller);
	unsubscribed.count = 0;
	vi.restoreAllMocks();
});

describe('createStreamReplayResponse', () => {
	it('stops following the stream when the client disconnects', async () => {
		const clearSpy = vi.spyOn(globalThis, 'clearInterval');
		startStream('c1');
		const res = createStreamReplayResponse('c1')!;
		const reader = res.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain('"start"');

		await reader.cancel();
		await vi.waitFor(() => expect(unsubscribed.count).toBe(1));
		expect(clearSpy).toHaveBeenCalled();
		// later chunks no longer reach the cancelled replay
		expect(() => appendChunk('c1', { type: 'finish' })).not.toThrow();
	});

	it('closes and unsubscribes once the stream is done', async () => {
		startStream('c2');
		const res = createStreamReplayResponse('c2')!;
		appendChunk('c2', { type: 'finish' });
		markDone('c2');
		const body = await res.text();
		expect(body).toContain('"finish"');
		expect(unsubscribed.count).toBe(1);
	});
});
