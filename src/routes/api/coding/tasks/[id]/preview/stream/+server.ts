import { error } from '@sveltejs/kit';
import type { PreviewStreamEvent } from '$lib/coding-preview.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { openPreviewViewer, type PreviewViewer } from '$lib/server/t3/preview.js';
import { CodingTaskError } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

const MAX_TAB_ID_LENGTH = 256;

function dimension(value: string | null, fallback: number, max: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n >= 100 ? Math.min(Math.round(n), max) : fallback;
}

/**
 * Streams one browser preview tab as SSE: `frame` events carry base64 JPEGs,
 * `state` events JSON ({@link PreviewStreamEvent}). The first state event is
 * `ready` with the viewer id that input is posted to; the last is `end`.
 *
 * T3 sends a frame only after the previous one is acknowledged, so frames are
 * acked once this response has room for them: a slow page slows the stream
 * instead of queueing frames in memory.
 */
export const GET: RequestHandler = ({ locals, params, url, request }) => {
	const user = requireUser(locals);
	const tabId = url.searchParams.get('tab');
	if (!tabId || tabId.length > MAX_TAB_ID_LENGTH) error(400, { message: 'Missing tab' });
	const size = {
		maxWidth: dimension(url.searchParams.get('w'), 1280, 3840),
		maxHeight: dimension(url.searchParams.get('h'), 800, 2160)
	};

	const encoder = new TextEncoder();
	let viewer: PreviewViewer | null = null;
	let closed = false;
	let ackOwed = false;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				const write = (chunk: string): boolean => {
					if (closed) return false;
					try {
						controller.enqueue(encoder.encode(chunk));
						return true;
					} catch {
						cleanup();
						return false;
					}
				};
				const state = (event: PreviewStreamEvent) =>
					write(`event: state\ndata: ${JSON.stringify(event)}\n\n`);
				const cleanup = () => {
					if (closed) return;
					closed = true;
					if (heartbeat) clearInterval(heartbeat);
					viewer?.close();
					try {
						controller.close();
					} catch {
						// already closed
					}
				};
				request.signal.addEventListener('abort', cleanup);
				heartbeat = setInterval(() => write(': ping\n\n'), 25_000);

				openPreviewViewer(getDb(), user.id, params.id, tabId, size, {
					onFrame: (jpeg) => {
						if (!write(`event: frame\ndata: ${Buffer.from(jpeg).toString('base64')}\n\n`)) {
							return;
						}
						if ((controller.desiredSize ?? 0) > 0) viewer?.ack();
						else ackOwed = true;
					},
					onEvent: (event) => {
						state(event);
						if (event.type === 'end') cleanup();
					}
				}).then(
					(opened) => {
						if (closed) {
							opened.close();
							return;
						}
						viewer = opened;
						state({ type: 'ready', viewerId: opened.id });
					},
					(e: unknown) => {
						const message =
							e instanceof CodingTaskError ? e.message : 'Could not open the browser preview';
						state({ type: 'end', reason: 'error', message });
						cleanup();
					}
				);
			},
			pull() {
				if (!ackOwed) return;
				ackOwed = false;
				viewer?.ack();
			},
			cancel() {
				closed = true;
				if (heartbeat) clearInterval(heartbeat);
				viewer?.close();
			}
		},
		// Counted in chunks: a couple of frames in flight is plenty.
		new CountQueuingStrategy({ highWaterMark: 4 })
	);

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			'x-accel-buffering': 'no'
		}
	});
};
