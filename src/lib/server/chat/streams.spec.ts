import type { UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import {
	abortStreamAndWait,
	claimStream,
	hasActiveStream,
	appendChunk,
	getStreamState,
	markDone,
	pushChunk,
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

describe('replay buffer', () => {
	it('merges consecutive deltas of the same part without mutating chunks', () => {
		const chunks: UIMessageChunk[] = [];
		const first = { type: 'text-delta', id: 't1', delta: 'Hel' } as const;
		pushChunk(chunks, { type: 'text-start', id: 't1' });
		pushChunk(chunks, first);
		pushChunk(chunks, { type: 'text-delta', id: 't1', delta: 'lo' });
		pushChunk(chunks, { type: 'text-delta', id: 't2', delta: '!' });
		pushChunk(chunks, { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"a"' });
		pushChunk(chunks, { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: ':1}' });
		expect(chunks).toEqual([
			{ type: 'text-start', id: 't1' },
			{ type: 'text-delta', id: 't1', delta: 'Hello' },
			{ type: 'text-delta', id: 't2', delta: '!' },
			{ type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"a":1}' }
		]);
		expect(first.delta).toBe('Hel');
	});

	it('keeps long token streams small and refuses replay once it overflows', () => {
		const controller = new AbortController();
		registerStream('c5', controller);
		appendChunk('c5', { type: 'text-start', id: 't1' }, controller);
		for (let i = 0; i < 50_000; i++) {
			appendChunk('c5', { type: 'text-delta', id: 't1', delta: 'x' }, controller);
		}
		expect(getStreamState('c5')!.chunks).toHaveLength(2);
		for (let i = 0; i < 20_001; i++) {
			appendChunk('c5', { type: 'start-step' }, controller);
		}
		// A partial replay would leave a hole in the message, so none is offered.
		expect(getStreamState('c5')).toBeNull();
		releaseStream('c5', controller);
	});
});

describe('claimStream', () => {
	it('registers synchronously after the wait, so a concurrent claim waits for it', async () => {
		const first = await claimStream('c6');
		expect(hasActiveStream('c6')).toBe(true);
		let secondClaimed = false;
		const second = claimStream('c6').then((c) => {
			secondClaimed = true;
			return c;
		});
		await new Promise((r) => setTimeout(r, 5));
		// The second claim aborted the first and waits until it is released.
		expect(first.signal.aborted).toBe(true);
		expect(secondClaimed).toBe(false);
		releaseStream('c6', first);
		const controller = await second;
		expect(controller.signal.aborted).toBe(false);
		expect(hasActiveStream('c6')).toBe(true);
		releaseStream('c6', controller);
		expect(hasActiveStream('c6')).toBe(false);
	});

	it('lets only one of two simultaneous waiters proceed at a time', async () => {
		const running = await claimStream('c7');
		const order: string[] = [];
		const a = claimStream('c7').then((c) => (order.push('a'), c));
		const b = claimStream('c7').then((c) => (order.push('b'), c));
		releaseStream('c7', running);
		const winner = await Promise.race([a, b]);
		await new Promise((r) => setTimeout(r, 5));
		// The loser saw the winner's claim, aborted it and is waiting for it.
		expect(order).toHaveLength(1);
		expect(winner.signal.aborted).toBe(true);
		releaseStream('c7', winner);
		const loser = await (order[0] === 'a' ? b : a);
		expect(loser.signal.aborted).toBe(false);
		releaseStream('c7', loser);
	});

	it('takes over a stream that is never released after the timeout', async () => {
		const stuck = await claimStream('c8');
		const controller = await claimStream('c8', 5);
		expect(stuck.signal.aborted).toBe(true);
		expect(hasActiveStream('c8')).toBe(true);
		releaseStream('c8', controller);
		releaseStream('c8', stuck);
	});
});
