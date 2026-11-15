import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageQueueState, ServerEvent } from '$lib/types.js';

const listeners: ((event: ServerEvent) => void)[] = [];
vi.mock('./events.svelte.js', () => ({
	onServerEvent: (listener: (event: ServerEvent) => void) => {
		listeners.push(listener);
		return () => listeners.splice(listeners.indexOf(listener), 1);
	},
	onServerEventResync: () => () => undefined
}));

const { messageQueue, startMessageQueueSync } = await import('./message-queue.svelte.js');

const item = { id: 'q1', text: 'first', files: [], createdAt: 1 };
const fetchMock = vi.fn<typeof fetch>();

function respond(body: unknown, status = 200) {
	fetchMock.mockResolvedValueOnce(
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
	);
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	messageQueue.forget('c1');
	vi.unstubAllGlobals();
});

describe('messageQueue', () => {
	it('loads and queues messages on the server', async () => {
		respond({ items: [], paused: false } satisfies MessageQueueState);
		await messageQueue.load('c1');
		expect(messageQueue.list('c1')).toEqual([]);

		respond({ items: [item], paused: false } satisfies MessageQueueState, 201);
		await messageQueue.add('c1', { text: 'first' });
		const [url, init] = fetchMock.mock.calls[1];
		expect(url).toBe('/api/conversations/c1/queue');
		expect(JSON.parse(init!.body as string)).toEqual({ text: 'first', files: [] });
		expect(messageQueue.list('c1')).toEqual([item]);
	});

	it('returns a removed message, or null when it was already sent', async () => {
		respond({ item, queue: { items: [], paused: false } });
		expect(await messageQueue.remove('c1', 'q1')).toEqual(item);
		expect(messageQueue.list('c1')).toEqual([]);

		respond({ message: 'The queued message was already sent' }, 404);
		respond({ items: [], paused: false });
		expect(await messageQueue.remove('c1', 'q1')).toBeNull();
	});

	it('pauses optimistically', async () => {
		respond({ items: [item], paused: false });
		await messageQueue.load('c1');
		respond({ items: [item], paused: true });
		const done = messageQueue.setPaused('c1', true);
		expect(messageQueue.isPaused('c1')).toBe(true);
		await done;
		expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({ paused: true });
	});

	it('reloads a loaded queue when the server says it changed', async () => {
		const stop = startMessageQueueSync();
		respond({ items: [item], paused: false });
		await messageQueue.load('c1');
		respond({ items: [], paused: false });
		for (const l of [...listeners]) l({ type: 'chat.queue.updated', conversationId: 'c1' });
		await vi.waitFor(() => expect(messageQueue.list('c1')).toEqual([]));
		// Queues this client never loaded aren't fetched.
		for (const l of [...listeners]) l({ type: 'chat.queue.updated', conversationId: 'c9' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		stop();
	});
});
