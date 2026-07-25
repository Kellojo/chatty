import { error } from '@sveltejs/kit';
import { JsonToSseTransformStream, UI_MESSAGE_STREAM_HEADERS, type UIMessageChunk } from 'ai';
import { requireUser } from '$lib/server/auth/guards.js';
import { getStreamState, subscribeChunks } from '$lib/server/chat/streams.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const conversation = getConversation(db, user.id, params.id);
	if (!conversation) error(404, { message: 'Conversation not found' });
	const state = getStreamState(params.id);
	if (!state) return new Response(null, { status: 204 });

	const chunks = new ReadableStream<UIMessageChunk>({
		start(controller) {
			for (const chunk of state.chunks) {
				controller.enqueue(chunk);
			}
			if (state.done) {
				controller.close();
				return;
			}
			const { unsubscribe } = subscribeChunks(params.id, (chunk) => {
				try {
					controller.enqueue(chunk);
				} catch {
					unsubscribe();
				}
			});
			const poll = setInterval(() => {
				if (getStreamState(params.id)?.done !== false) {
					clearInterval(poll);
					unsubscribe();
					try {
						controller.close();
					} catch {
						// already closed
					}
				}
			}, 100);
			poll.unref?.();
		},
		cancel() {
			// client disconnected; the server-side stream keeps running
		}
	});

	return new Response(
		chunks.pipeThrough(new JsonToSseTransformStream()).pipeThrough(new TextEncoderStream()),
		{
			headers: UI_MESSAGE_STREAM_HEADERS
		}
	);
};
