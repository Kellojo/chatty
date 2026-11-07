import { describe, expect, it } from 'vitest';
import { readBodyLimited } from './readBody.js';

function streamOf(chunks: string[], onCancel?: () => void, endless = false): ReadableStream {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[i++]));
			else if (endless) controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
			else controller.close();
		},
		cancel() {
			onCancel?.();
		}
	});
}

describe('readBodyLimited', () => {
	it('returns the full body when under the limit', async () => {
		const res = new Response(streamOf(['hello ', 'world']));
		const { body, truncated } = await readBodyLimited(res, 100);
		expect(body.toString()).toBe('hello world');
		expect(truncated).toBe(false);
	});

	it('is not truncated at exactly the limit', async () => {
		const { body, truncated } = await readBodyLimited(new Response('abcde'), 5);
		expect(body.toString()).toBe('abcde');
		expect(truncated).toBe(false);
	});

	it('truncates to the limit and cancels the stream', async () => {
		let cancelled = false;
		const res = new Response(streamOf(['abc', 'def', 'ghi'], () => (cancelled = true)));
		const { body, truncated } = await readBodyLimited(res, 4);
		expect(body.toString()).toBe('abcd');
		expect(truncated).toBe(true);
		expect(cancelled).toBe(true);
	});

	it('stops reading an endless body', async () => {
		const res = new Response(streamOf([], undefined, true));
		const { body, truncated } = await readBodyLimited(res, 10_000);
		expect(body.length).toBe(10_000);
		expect(truncated).toBe(true);
	});

	it('handles an empty body', async () => {
		const { body, truncated } = await readBodyLimited(new Response(null), 10);
		expect(body.length).toBe(0);
		expect(truncated).toBe(false);
	});
});
