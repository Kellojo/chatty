import { SvelteMap } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';
import { uploadAttachments } from '$lib/chat-send.js';
import type { MessageQueueState, QueuedMessage } from '$lib/types.js';
import { onServerEvent, onServerEventResync } from './events.svelte.js';

export type { QueuedMessage };

const EMPTY: MessageQueueState = { items: [], paused: false };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	const data = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
	if (!res.ok || !data) throw new Error(data?.message ?? 'The message queue is unavailable');
	return data;
}

function jsonInit(method: string, body?: unknown): RequestInit {
	return body === undefined
		? { method }
		: { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// Messages written while a reply is still running, per conversation. The
// server keeps them and sends them one at a time once the reply finishes (see
// src/lib/server/chat/queue.ts), so they survive reloads and show on every
// device. This is the client's synced copy: a chat view loads its queue and
// changes from anywhere arrive as `chat.queue.updated`.
class MessageQueues {
	#queues = new SvelteMap<string, MessageQueueState>();

	#base(conversationId: string): string {
		return `/api/conversations/${encodeURIComponent(conversationId)}/queue`;
	}

	#set(conversationId: string, state: MessageQueueState): MessageQueueState {
		this.#queues.set(conversationId, state);
		return state;
	}

	list(conversationId: string): QueuedMessage[] {
		return (this.#queues.get(conversationId) ?? EMPTY).items;
	}

	isPaused(conversationId: string): boolean {
		return (this.#queues.get(conversationId) ?? EMPTY).paused;
	}

	/** Conversations whose queue this client has loaded. */
	conversationIds(): string[] {
		return [...this.#queues.keys()];
	}

	/** Fetches the server's copy of the queue. */
	async load(conversationId: string): Promise<MessageQueueState> {
		return this.#set(conversationId, await request(this.#base(conversationId)));
	}

	/** Uploads the files and queues the message on the server. Throws on failure. */
	async add(conversationId: string, message: { text: string; files?: File[] }): Promise<void> {
		const files = await uploadAttachments(conversationId, message.files ?? []);
		this.#set(
			conversationId,
			await request(this.#base(conversationId), jsonInit('POST', { text: message.text, files }))
		);
	}

	/** Takes a message off the queue; null when it was already sent. */
	async remove(conversationId: string, id: string): Promise<QueuedMessage | null> {
		try {
			const { item, queue } = await request<{ item: QueuedMessage; queue: MessageQueueState }>(
				`${this.#base(conversationId)}/${encodeURIComponent(id)}`,
				jsonInit('DELETE')
			);
			this.#set(conversationId, queue);
			return item;
		} catch {
			void this.load(conversationId).catch(() => undefined);
			return null;
		}
	}

	/** Sends a queued message now, interrupting a running reply. Throws on failure. */
	async sendNow(conversationId: string, id: string): Promise<void> {
		this.#set(
			conversationId,
			await request(
				`${this.#base(conversationId)}/${encodeURIComponent(id)}/send`,
				jsonInit('POST')
			)
		);
	}

	async setPaused(conversationId: string, paused: boolean): Promise<void> {
		const current = this.#queues.get(conversationId) ?? EMPTY;
		if (current.paused === paused) return;
		this.#set(conversationId, { ...current, paused });
		try {
			this.#set(
				conversationId,
				await request(this.#base(conversationId), jsonInit('PATCH', { paused }))
			);
		} catch (e) {
			void this.load(conversationId).catch(() => undefined);
			throw e;
		}
	}

	pause(conversationId: string): void {
		this.setPaused(conversationId, true).catch(() => undefined);
	}

	resume(conversationId: string): void {
		this.setPaused(conversationId, false).catch((e) =>
			toast.error(e instanceof Error ? e.message : 'Failed to resume the queue')
		);
	}

	forget(conversationId: string): void {
		this.#queues.delete(conversationId);
	}
}

export const messageQueue = new MessageQueues();

/**
 * Keeps loaded queues in sync with the server and reports queued messages it
 * failed to send. Returns a stop function.
 */
export function startMessageQueueSync(): () => void {
	const offEvent = onServerEvent((event) => {
		if (event.type !== 'chat.queue.updated') return;
		if (event.error) toast.error(event.error);
		if (messageQueue.conversationIds().includes(event.conversationId)) {
			void messageQueue.load(event.conversationId).catch(() => undefined);
		}
	});
	// Updates may have been missed while disconnected.
	const offResync = onServerEventResync(() => {
		for (const id of messageQueue.conversationIds()) {
			void messageQueue.load(id).catch(() => undefined);
		}
	});
	return () => {
		offEvent();
		offResync();
	};
}
