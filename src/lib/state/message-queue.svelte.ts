import { SvelteMap, SvelteSet } from 'svelte/reactivity';

export interface QueuedMessage {
	id: string;
	text: string;
	files: File[];
}

// Messages written while a reply is still running, per conversation. They are
// sent one at a time once the chat is idle, unless the queue is paused (the
// user stopped the reply, or sending failed). The open chat view sends its own
// queue; for chats that aren't open, ./message-queue-runner.ts does. Lives in
// memory only, so a page reload drops it.
class MessageQueues {
	#queues = new SvelteMap<string, QueuedMessage[]>();
	#paused = new SvelteSet<string>();
	#attached = new Map<string, number>();

	list(conversationId: string): QueuedMessage[] {
		return this.#queues.get(conversationId) ?? [];
	}

	add(conversationId: string, message: { text: string; files?: File[] }): QueuedMessage {
		const item: QueuedMessage = {
			id: crypto.randomUUID(),
			text: message.text,
			files: message.files ?? []
		};
		this.#queues.set(conversationId, [...this.list(conversationId), item]);
		return item;
	}

	/** Puts a message back at the front, e.g. after it failed to send. */
	prepend(conversationId: string, item: QueuedMessage): void {
		this.#queues.set(conversationId, [item, ...this.list(conversationId)]);
	}

	remove(conversationId: string, id: string): QueuedMessage | undefined {
		const items = this.list(conversationId);
		const item = items.find((m) => m.id === id);
		if (!item) return undefined;
		const rest = items.filter((m) => m !== item);
		if (rest.length > 0) this.#queues.set(conversationId, rest);
		else this.#queues.delete(conversationId);
		return item;
	}

	isPaused(conversationId: string): boolean {
		return this.#paused.has(conversationId);
	}

	pause(conversationId: string): void {
		this.#paused.add(conversationId);
	}

	resume(conversationId: string): void {
		this.#paused.delete(conversationId);
	}

	/** Marks the conversation as open in a chat view, which then sends its queue. */
	attach(conversationId: string): () => void {
		this.#attached.set(conversationId, (this.#attached.get(conversationId) ?? 0) + 1);
		return () => {
			const count = (this.#attached.get(conversationId) ?? 1) - 1;
			if (count > 0) this.#attached.set(conversationId, count);
			else this.#attached.delete(conversationId);
		};
	}

	isAttached(conversationId: string): boolean {
		return this.#attached.has(conversationId);
	}

	/** Conversations with messages waiting. */
	conversationIds(): string[] {
		return [...this.#queues.keys()];
	}

	clear(conversationId: string): void {
		this.#queues.delete(conversationId);
		this.#paused.delete(conversationId);
	}
}

export const messageQueue = new MessageQueues();
