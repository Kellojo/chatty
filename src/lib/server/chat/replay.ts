import { JsonToSseTransformStream, UI_MESSAGE_STREAM_HEADERS, type UIMessageChunk } from 'ai';
import { getStreamState, subscribeChunks } from './streams.js';

/**
 * An SSE response that replays a conversation's buffered stream chunks and then
 * follows it live until it is done. Returns null when nothing is streaming.
 * The producer keeps running if the client disconnects.
 */
export function createStreamReplayResponse(conversationId: string): Response | null {
	const state = getStreamState(conversationId);
	if (!state) return null;

	// Set while following the live stream; cleared on the stream's end or when
	// the client disconnects, so neither the listener nor the poll outlives it.
	let stopFollowing: (() => void) | null = null;

	const chunks = new ReadableStream<UIMessageChunk>({
		start(controller) {
			for (const chunk of state.chunks) {
				controller.enqueue(chunk);
			}
			if (state.done) {
				controller.close();
				return;
			}
			const { unsubscribe } = subscribeChunks(conversationId, (chunk) => {
				try {
					controller.enqueue(chunk);
				} catch {
					stopFollowing?.();
				}
			});
			const poll = setInterval(() => {
				if (getStreamState(conversationId)?.done !== false) {
					stopFollowing?.();
					try {
						controller.close();
					} catch {
						// already closed
					}
				}
			}, 100);
			poll.unref?.();
			stopFollowing = () => {
				clearInterval(poll);
				unsubscribe();
				stopFollowing = null;
			};
		},
		cancel() {
			// client disconnected; the server-side stream keeps running
			stopFollowing?.();
		}
	});

	return new Response(
		chunks.pipeThrough(new JsonToSseTransformStream()).pipeThrough(new TextEncoderStream()),
		{ headers: UI_MESSAGE_STREAM_HEADERS }
	);
}
