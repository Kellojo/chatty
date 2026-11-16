// The coding tasks started from a chat's proposals (`propose_coding_task`),
// shared by the chat's proposal cards and kept current while the tasks work.

import type { ProposedCodingTask } from '$lib/coding-task-proposal.js';
import { onServerEvent, onServerEventResync } from './events.svelte.js';

class ProposedCodingTasks {
	/** Null until loaded (or when loading failed). */
	tasks = $state<ProposedCodingTask[] | null>(null);
	private timer: ReturnType<typeof setTimeout> | null = null;
	private seq = 0;

	constructor(private readonly chatId: string) {
		void this.load();
		onServerEvent((event) => {
			// Status, branch and PR changes of one of these tasks.
			if (
				(event.type === 'coding.task.updated' || event.type === 'coding.thread.finished') &&
				this.tasks?.some((t) => t.conversationId === event.conversationId)
			) {
				this.refresh();
			}
		});
		onServerEventResync(() => this.refresh());
	}

	byToolCall(toolCallId: string): ProposedCodingTask | null {
		return this.tasks?.find((t) => t.toolCallId === toolCallId) ?? null;
	}

	/** Reloads soon; bursts of updates share one request. */
	refresh(): void {
		this.timer ??= setTimeout(() => {
			this.timer = null;
			void this.load();
		}, 300);
	}

	private async load(): Promise<void> {
		const seq = ++this.seq;
		try {
			const res = await fetch(`/api/coding/tasks?proposedIn=${encodeURIComponent(this.chatId)}`);
			if (!res.ok) return;
			const body = (await res.json()) as { tasks: ProposedCodingTask[] };
			if (seq === this.seq) this.tasks = body.tasks;
		} catch {
			// offline: the cards keep what they showed, the next update retries
		}
	}
}

// One per chat for the page's lifetime (a handful at most): their listeners stay.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain registry, nothing renders from it
const byChat = new Map<string, ProposedCodingTasks>();

export function proposedCodingTasks(chatId: string): ProposedCodingTasks {
	let store = byChat.get(chatId);
	if (!store) byChat.set(chatId, (store = new ProposedCodingTasks(chatId)));
	return store;
}
