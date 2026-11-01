import { describe, expect, it } from 'vitest';
import {
	abortStreamAndWait,
	appendChunk,
	getStreamState,
	markDone,
	registerStream,
	releaseStream
} from './streams.js';

describe('abortStreamAndWait', () => {
	it('returns immediately when nothing is running', async () => {
		await expect(abortStreamAndWait('none')).resolves.toBeUndefined();
	});

	it('aborts the stream and waits until it has been released', async () => {
		const controller = new AbortController();
		registerStream('c1', controller);
		let settled = false;
		const wait = abortStreamAndWait('c1').then(() => (settled = true));
		await new Promise((r) => setTimeout(r, 5));
		expect(controller.signal.aborted).toBe(true);
		expect(settled).toBe(false);
		releaseStream('c1', controller);
		await wait;
		expect(settled).toBe(true);
	});

	it('gives up after the timeout if the stream is never released', async () => {
		const controller = new AbortController();
		registerStream('c2', controller);
		await abortStreamAndWait('c2', 5);
		expect(controller.signal.aborted).toBe(true);
		releaseStream('c2', controller);
	});
});

describe('stream ownership', () => {
	it('ignores chunks and completion from a replaced stream', () => {
		const oldController = new AbortController();
		const newController = new AbortController();
		registerStream('c3', oldController);
		registerStream('c3', newController);
		appendChunk('c3', { type: 'start' } as never, oldController);
		markDone('c3', oldController);
		expect(getStreamState('c3')).toEqual({ chunks: [], done: false });
		appendChunk('c3', { type: 'start' } as never, newController);
		markDone('c3', newController);
		expect(getStreamState('c3')).toEqual({ chunks: [{ type: 'start' }], done: true });
		releaseStream('c3', newController);
	});

	it('still settles waiters of a stream that gets replaced', async () => {
		const oldController = new AbortController();
		const newController = new AbortController();
		registerStream('c4', oldController);
		const wait = abortStreamAndWait('c4');
		registerStream('c4', newController);
		releaseStream('c4', oldController);
		await expect(wait).resolves.toBeUndefined();
		expect(getStreamState('c4')).not.toBeNull();
		releaseStream('c4', newController);
	});
});
