import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const handleChatRequest = vi.fn<(...args: unknown[]) => Promise<Response>>(
	async () => new Response('done')
);
vi.mock('./service.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./service.js')>();
	return { ...actual, handleChatRequest: (...args: unknown[]) => handleChatRequest(...args) };
});

const { getDb, closeDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { enqueueMessage, getMessageQueue, setQueuePaused } =
	await import('../db/repo/queued-messages.js');
const { publishServerEvent, subscribeServerEvents } = await import('../events/bus.js');
const { claimStream, releaseStream } = await import('./streams.js');
const { ChatRequestError } = await import('./service.js');
const queue = await import('./queue.js');

let conversationId: string;
let stop: () => void;

/** Lets the dispatcher's deferred handling and the delivery run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

function finishTurn(completed: boolean) {
	publishServerEvent('u1', { type: 'chat.stream.started', conversationId });
	if (completed) publishServerEvent('u1', { type: 'chat.message_completed', conversationId });
	publishServerEvent('u1', { type: 'chat.stream.finished', conversationId });
}

function sentTexts(): string[] {
	return handleChatRequest.mock.calls.map((call) => {
		const body = call[1] as { message: { parts: { type: string; text?: string }[] } };
		return body.message.parts.find((p) => p.type === 'text')?.text ?? '';
	});
}

beforeEach(() => {
	const db = getDb();
	db.prepare(
		'INSERT OR IGNORE INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
	conversationId = createConversation(db, 'u1').id;
	handleChatRequest.mockClear();
	stop = queue.startMessageQueueDispatcher();
});

afterEach(() => stop());
afterAll(() => closeDb());

describe('message queue dispatcher', () => {
	it('sends the next message once a reply completes, one at a time', async () => {
		enqueueMessage(getDb(), conversationId, { text: 'first', files: [] });
		enqueueMessage(getDb(), conversationId, { text: '/skill review check it', files: [] });
		finishTurn(true);
		await settle();
		expect(sentTexts()).toEqual(['first']);
		expect(getMessageQueue(getDb(), conversationId).items).toHaveLength(1);

		finishTurn(true);
		await settle();
		expect(sentTexts()).toEqual(['first', 'check it']);
		expect(handleChatRequest.mock.calls[1][1]).toMatchObject({ skill: 'review' });
		expect(getMessageQueue(getDb(), conversationId).items).toHaveLength(0);
	});

	it('pauses instead when the reply was stopped or failed', async () => {
		enqueueMessage(getDb(), conversationId, { text: 'first', files: [] });
		const events: string[] = [];
		const off = subscribeServerEvents('u1', (_u, e) => events.push(e.type));
		finishTurn(false);
		await settle();
		off();
		expect(handleChatRequest).not.toHaveBeenCalled();
		expect(getMessageQueue(getDb(), conversationId).paused).toBe(true);
		expect(events).toContain('chat.queue.updated');

		queue.setPaused('u1', conversationId, false);
		await settle();
		expect(sentTexts()).toEqual(['first']);
	});

	it('leaves the queue alone when a newer message took over the reply', async () => {
		enqueueMessage(getDb(), conversationId, { text: 'first', files: [] });
		const controller = await claimStream(conversationId);
		finishTurn(false);
		await settle();
		expect(handleChatRequest).not.toHaveBeenCalled();
		expect(getMessageQueue(getDb(), conversationId).paused).toBe(false);
		releaseStream(conversationId, controller);
	});

	it('does not send while the queue is paused', async () => {
		enqueueMessage(getDb(), conversationId, { text: 'first', files: [] });
		setQueuePaused(getDb(), conversationId, true);
		finishTurn(true);
		await settle();
		expect(handleChatRequest).not.toHaveBeenCalled();
	});

	it('puts a message that failed to send back at the front, paused', async () => {
		handleChatRequest.mockRejectedValueOnce(new ChatRequestError(400, 'No model'));
		enqueueMessage(getDb(), conversationId, { text: 'first', files: [] });
		enqueueMessage(getDb(), conversationId, { text: 'second', files: [] });
		const errors: string[] = [];
		const off = subscribeServerEvents('u1', (_u, e) => {
			if (e.type === 'chat.queue.updated' && e.error) errors.push(e.error);
		});
		finishTurn(true);
		await settle();
		off();
		const state = getMessageQueue(getDb(), conversationId);
		expect(state.items.map((m) => m.text)).toEqual(['first', 'second']);
		expect(state.paused).toBe(true);
		expect(errors).toEqual(['No model']);
	});

	it('sends a queued message now and resumes the queue', async () => {
		const row = enqueueMessage(getDb(), conversationId, { text: 'later', files: [] });
		setQueuePaused(getDb(), conversationId, true);
		await queue.sendNow('u1', conversationId, row.id);
		expect(sentTexts()).toEqual(['later']);
		expect(getMessageQueue(getDb(), conversationId)).toEqual({ items: [], paused: false });
		await expect(queue.sendNow('u1', conversationId, row.id)).rejects.toThrow(/already sent/);
	});

	it('rejects file parts from another conversation', () => {
		expect(() =>
			queue.enqueue('u1', conversationId, {
				text: 'look',
				files: [
					{
						type: 'file',
						url: '/api/conversations/other/attachments/a1',
						mediaType: 'image/png',
						filename: 'a.png'
					}
				]
			})
		).toThrow(ChatRequestError);
	});
});
