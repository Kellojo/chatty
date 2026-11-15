// Messages written while a reply is still running wait in the conversation's
// queue (queued_messages) and are sent by the server, one at a time, once the
// reply has finished. Kept server-side so the queue survives reloads, shows on
// every device, and keeps going with no client connected. A reply that ends
// without completing (stopped, failed) pauses the queue until the user resumes.

import { randomUUID } from 'node:crypto';
import type { UIMessage } from 'ai';
import { parseSkillCommand } from '$lib/chat-send.js';
import type { MessageQueueState, QueuedMessage } from '$lib/types.js';
import { getDb } from '../db/index.js';
import { getCodingConversation } from '../db/repo/coding-conversations.js';
import {
	enqueueMessage,
	getMessageQueue,
	isQueuePaused,
	listQueuedConversations,
	listQueuedMessages,
	removeQueuedMessage,
	requeueFirst,
	setQueuePaused,
	takeFirstQueuedMessage,
	toPublic as queuedToPublic,
	type QueuedMessageRow
} from '../db/repo/queued-messages.js';
import { publishServerEvent, subscribeAllServerEvents } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { assertValidUserParts, ChatRequestError, handleChatRequest } from './service.js';
import { hasActiveStream } from './streams.js';

const log = createLogger('chat-queue');

/**
 * How long a newly queued message waits before it may go out on an idle chat.
 * The client queues while it is itself sending; this lets that request claim
 * the conversation first so the queued message stays behind it.
 */
const ENQUEUE_GRACE_MS = 500;
/** On startup, coding tasks resume following their threads first. */
const STARTUP_DELAY_MS = 5000;

// Kept on globalThis so a dev-server hot reload doesn't double-send.
const globalState = globalThis as {
	__messageQueue?: { sending: Set<string>; stop?: () => void };
};
globalState.__messageQueue ??= { sending: new Set() };
const sending = globalState.__messageQueue.sending;

function announce(userId: string, conversationId: string, error?: string): void {
	publishServerEvent(userId, {
		type: 'chat.queue.updated',
		conversationId,
		...(error ? { error } : {})
	});
}

function toUserMessage(row: QueuedMessageRow): { message: UIMessage; skill?: string } {
	const { text, skill } = parseSkillCommand(row.text);
	const files = JSON.parse(row.parts) as QueuedMessage['files'];
	return {
		message: {
			id: randomUUID(),
			role: 'user',
			parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files]
		},
		skill
	};
}

/**
 * Starts a turn with the queued message. Generation runs server-side whoever
 * reads the stream, so the response is drained here; open chat views follow
 * it through `chat.stream.started`. On failure the message goes back to the
 * front and the queue pauses.
 */
async function deliver(userId: string, row: QueuedMessageRow): Promise<void> {
	const conversationId = row.conversation_id;
	sending.add(conversationId);
	announce(userId, conversationId);
	try {
		const { message, skill } = toUserMessage(row);
		const response = await handleChatRequest(userId, { conversationId, message, skill });
		void drain(response);
	} catch (e) {
		const db = getDb();
		requeueFirst(db, row);
		setQueuePaused(db, conversationId, true);
		const error = e instanceof Error ? e.message : 'Failed to send a queued message';
		log.warn('Failed to send a queued message', { conversationId, error });
		announce(userId, conversationId, error);
	} finally {
		sending.delete(conversationId);
	}
}

async function drain(response: Response): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) return;
	try {
		while (!(await reader.read()).done) {
			// persistence runs off the turn's own copy of the stream
		}
	} catch {
		// the turn records its own failures
	}
}

/** Sends the next queued message if the conversation is idle and its queue isn't paused. */
export async function sendNextQueued(userId: string, conversationId: string): Promise<void> {
	if (sending.has(conversationId) || hasActiveStream(conversationId)) return;
	const db = getDb();
	if (isQueuePaused(db, conversationId)) return;
	// A coding task waiting on the user's answer isn't done with its turn.
	if (getCodingConversation(db, conversationId)?.pending_request) return;
	const row = takeFirstQueuedMessage(db, conversationId);
	if (row) await deliver(userId, row);
}

/** Queues a message; on an idle chat it goes out right away. Validates its file parts. */
export function enqueue(
	userId: string,
	conversationId: string,
	message: { text: string; files: QueuedMessage['files'] }
): MessageQueueState {
	assertValidUserParts(conversationId, {
		id: 'queued',
		role: 'user',
		parts: message.files
	});
	const db = getDb();
	enqueueMessage(db, conversationId, message);
	announce(userId, conversationId);
	setTimeout(() => void sendNextQueued(userId, conversationId), ENQUEUE_GRACE_MS);
	return getMessageQueue(db, conversationId);
}

export function remove(
	userId: string,
	conversationId: string,
	id: string
): { item: QueuedMessage; queue: MessageQueueState } | null {
	const db = getDb();
	const row = removeQueuedMessage(db, conversationId, id);
	if (!row) return null;
	if (listQueuedMessages(db, conversationId).length === 0)
		setQueuePaused(db, conversationId, false);
	announce(userId, conversationId);
	return {
		item: queuedToPublic(row),
		queue: getMessageQueue(db, conversationId)
	};
}

/** Pauses or resumes the queue; resuming an idle chat sends the next message. */
export function setPaused(
	userId: string,
	conversationId: string,
	paused: boolean
): MessageQueueState {
	const db = getDb();
	setQueuePaused(db, conversationId, paused);
	announce(userId, conversationId);
	if (!paused) void sendNextQueued(userId, conversationId);
	return getMessageQueue(db, conversationId);
}

/**
 * Sends a queued message now, interrupting a running reply, and resumes the
 * queue. Throws ChatRequestError(404) when the message was already sent.
 */
export async function sendNow(userId: string, conversationId: string, id: string): Promise<void> {
	const db = getDb();
	const row = removeQueuedMessage(db, conversationId, id);
	if (!row) throw new ChatRequestError(404, 'The queued message was already sent');
	setQueuePaused(db, conversationId, false);
	await deliver(userId, row);
}

/** What to do with a queue once its conversation's reply has ended. */
function onTurnEnded(userId: string, conversationId: string, completed: boolean): void {
	// A newer message took over (superseded this reply): its own end decides.
	if (hasActiveStream(conversationId) || sending.has(conversationId)) return;
	const db = getDb();
	if (listQueuedMessages(db, conversationId).length === 0) return;
	if (completed) {
		void sendNextQueued(userId, conversationId);
	} else if (!isQueuePaused(db, conversationId)) {
		// Stopped or failed: wait for the user.
		setQueuePaused(db, conversationId, true);
		announce(userId, conversationId);
	}
}

/**
 * Watches replies finish and sends the queue. Returns a stop function. Also
 * picks up queues left waiting when the server last stopped.
 */
export function startMessageQueueDispatcher(): () => void {
	globalState.__messageQueue!.stop?.();
	// Replies that finished successfully, between `chat.message_completed` and
	// `chat.stream.finished`. A finish without it (error, stop) pauses the queue.
	const completed = new Set<string>();
	const unsubscribe = subscribeAllServerEvents((userId, event) => {
		if (event.type === 'chat.stream.started') completed.delete(event.conversationId);
		else if (event.type === 'chat.message_completed') completed.add(event.conversationId);
		else if (event.type === 'chat.stream.finished') {
			const id = event.conversationId;
			const ok = completed.delete(id);
			// Deferred: a request superseding this reply claims the conversation
			// right after it is released, before this runs.
			setTimeout(() => {
				try {
					onTurnEnded(userId, id, ok);
				} catch (e) {
					log.error('Message queue failed', {
						conversationId: id,
						error: e instanceof Error ? e.message : String(e)
					});
				}
			}, 0);
		}
	});
	const startup = setTimeout(() => {
		try {
			for (const { conversationId, userId } of listQueuedConversations(getDb())) {
				void sendNextQueued(userId, conversationId);
			}
		} catch (e) {
			log.error('Failed to resume message queues', {
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}, STARTUP_DELAY_MS);
	const stop = () => {
		unsubscribe();
		clearTimeout(startup);
	};
	globalState.__messageQueue!.stop = stop;
	return stop;
}
