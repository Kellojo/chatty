// Sends queued messages for chats that aren't open. The open chat view drains
// its own queue (it owns the live Chat); everything else is driven by server
// events here: once a reply finishes, the next queued message is posted
// directly. Generation runs server-side regardless of who reads the stream, so
// the response body is dropped and the chat view picks the reply up when opened.

import { toast } from 'svelte-sonner';
import { parseSkillCommand, uploadAttachments } from '$lib/chat-send.js';
import { onServerEvent, onServerEventResync } from './events.svelte.js';
import { messageQueue } from './message-queue.svelte.js';

export function startMessageQueueRunner(): () => void {
	// Replies that finished successfully, between `message_completed` and
	// `stream.finished`. A finish without it (error, stop) pauses the queue.
	const completed = new Set<string>();
	const sending = new Set<string>();

	async function sendNext(conversationId: string): Promise<void> {
		if (
			sending.has(conversationId) ||
			messageQueue.isAttached(conversationId) ||
			messageQueue.isPaused(conversationId)
		) {
			return;
		}
		const item = messageQueue.list(conversationId)[0];
		if (!item) return;
		messageQueue.remove(conversationId, item.id);
		sending.add(conversationId);
		try {
			const { text, skill } = parseSkillCommand(item.text);
			const fileParts = await uploadAttachments(conversationId, item.files);
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					conversationId,
					message: {
						id: crypto.randomUUID(),
						role: 'user',
						parts: [...(text ? [{ type: 'text', text }] : []), ...fileParts]
					},
					...(skill ? { skill } : {})
				})
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message ?? 'Failed to send a queued message');
			}
			void res.body?.cancel().catch(() => undefined);
		} catch (e) {
			messageQueue.prepend(conversationId, item);
			messageQueue.pause(conversationId);
			toast.error(e instanceof Error ? e.message : 'Failed to send a queued message');
		} finally {
			sending.delete(conversationId);
		}
	}

	const offEvent = onServerEvent((event) => {
		if (!('conversationId' in event) || typeof event.conversationId !== 'string') return;
		const id = event.conversationId;
		if (event.type === 'chat.stream.started') completed.delete(id);
		else if (event.type === 'chat.message_completed') completed.add(id);
		else if (event.type === 'chat.stream.finished') {
			const ok = completed.delete(id);
			if (messageQueue.isAttached(id) || messageQueue.list(id).length === 0) return;
			if (ok) void sendNext(id);
			else messageQueue.pause(id);
		}
	});

	// Events may have been missed while disconnected: send for every queue
	// whose chat is no longer generating.
	const offResync = onServerEventResync(() => {
		const ids = messageQueue.conversationIds().filter((id) => !messageQueue.isAttached(id));
		if (ids.length === 0) return;
		void fetch('/api/chat/active')
			.then((res) => (res.ok ? res.json() : null))
			.then((data: { conversationIds: string[] } | null) => {
				if (!data) return;
				for (const id of ids) if (!data.conversationIds.includes(id)) void sendNext(id);
			})
			.catch(() => undefined);
	});

	return () => {
		offEvent();
		offResync();
	};
}
