import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '$lib/types.js';

const listeners: ((event: ServerEvent) => void)[] = [];
vi.mock('./events.svelte.js', () => ({
	onServerEvent: (listener: (event: ServerEvent) => void) => {
		listeners.push(listener);
		return () => listeners.splice(listeners.indexOf(listener), 1);
	},
	onServerEventResync: () => () => undefined
}));

const { startMessageQueueRunner } = await import('./message-queue-runner.js');
const { messageQueue } = await import('./message-queue.svelte.js');

function emit(event: ServerEvent) {
	for (const listener of [...listeners]) listener(event);
}

describe('message queue runner', () => {
	let stop: () => void;
	const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

	beforeEach(() => {
		fetchMock.mockClear();
		vi.stubGlobal('fetch', fetchMock);
		stop = startMessageQueueRunner();
	});

	afterEach(() => {
		stop();
		vi.unstubAllGlobals();
		messageQueue.clear('c1');
	});

	it('sends the next message once a reply in a closed chat completes', async () => {
		messageQueue.add('c1', { text: 'next please' });
		messageQueue.add('c1', { text: 'and then this' });
		emit({ type: 'chat.message_completed', conversationId: 'c1' });
		emit({ type: 'chat.stream.finished', conversationId: 'c1' });

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/chat');
		const body = JSON.parse(String(init.body));
		expect(body.conversationId).toBe('c1');
		expect(body.message.parts).toEqual([{ type: 'text', text: 'next please' }]);
		expect(messageQueue.list('c1').map((m) => m.text)).toEqual(['and then this']);
	});

	it('pauses instead of sending when a reply ends without completing', () => {
		messageQueue.add('c1', { text: 'next please' });
		emit({ type: 'chat.stream.finished', conversationId: 'c1' });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(messageQueue.isPaused('c1')).toBe(true);
	});

	it('leaves an open chat to send its own queue', () => {
		const detach = messageQueue.attach('c1');
		messageQueue.add('c1', { text: 'next please' });
		emit({ type: 'chat.message_completed', conversationId: 'c1' });
		emit({ type: 'chat.stream.finished', conversationId: 'c1' });
		expect(fetchMock).not.toHaveBeenCalled();
		detach();
	});

	it('puts a message back and pauses when sending fails', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ message: 'nope' }, { status: 400 }));
		messageQueue.add('c1', { text: 'next please' });
		emit({ type: 'chat.message_completed', conversationId: 'c1' });
		emit({ type: 'chat.stream.finished', conversationId: 'c1' });
		await vi.waitFor(() => expect(messageQueue.isPaused('c1')).toBe(true));
		expect(messageQueue.list('c1').map((m) => m.text)).toEqual(['next please']);
	});
});
