import type { UIMessageChunk } from 'ai';

const MAX_CHUNKS = 2000;

interface ActiveStream {
	controller: AbortController;
	chunks: UIMessageChunk[];
	listeners: Set<(chunk: UIMessageChunk) => void>;
	done: boolean;
	released: Promise<void>;
	release: () => void;
}

const DEFAULT_ABORT_WAIT_MS = 5000;

const streams = new Map<string, ActiveStream>();
// Keyed by controller rather than conversation: a replaced stream is gone from
// `streams` but still finishes later, and anyone waiting on it must be told.
const byController = new WeakMap<AbortController, ActiveStream>();

export function registerStream(conversationId: string, controller: AbortController): void {
	streams.get(conversationId)?.controller.abort();
	let release = () => {};
	const released = new Promise<void>((resolve) => (release = resolve));
	const stream: ActiveStream = {
		controller,
		chunks: [],
		listeners: new Set(),
		done: false,
		released,
		release
	};
	streams.set(conversationId, stream);
	byController.set(controller, stream);
}

// `owner` keeps a replaced stream that is still winding down from writing into
// its successor's buffer.
export function appendChunk(
	conversationId: string,
	chunk: UIMessageChunk,
	owner?: AbortController
): void {
	const stream = streams.get(conversationId);
	if (!stream || (owner && stream.controller !== owner)) return;
	if (stream.chunks.length < MAX_CHUNKS) {
		stream.chunks.push(chunk);
	}
	for (const listener of stream.listeners) {
		listener(chunk);
	}
}

export function subscribeChunks(
	conversationId: string,
	listener: (chunk: UIMessageChunk) => void
): { unsubscribe: () => void } {
	const stream = streams.get(conversationId);
	if (!stream) return { unsubscribe: () => undefined };
	stream.listeners.add(listener);
	return {
		unsubscribe: () => {
			stream.listeners.delete(listener);
		}
	};
}

export function getStreamState(
	conversationId: string
): { chunks: UIMessageChunk[]; done: boolean } | null {
	const stream = streams.get(conversationId);
	if (!stream) return null;
	return { chunks: [...stream.chunks], done: stream.done };
}

export function markDone(conversationId: string, owner?: AbortController): void {
	const stream = streams.get(conversationId);
	if (stream && (!owner || stream.controller === owner)) stream.done = true;
}

export function abortStream(conversationId: string): boolean {
	const stream = streams.get(conversationId);
	if (!stream) return false;
	stream.controller.abort();
	return true;
}

/**
 * Aborts the running stream, if any, and waits until it has persisted its partial
 * message and been released, so that a new request sees the final history. The
 * wait is bounded so a stuck stream can't block new messages.
 */
export async function abortStreamAndWait(
	conversationId: string,
	timeoutMs = DEFAULT_ABORT_WAIT_MS
): Promise<void> {
	const stream = streams.get(conversationId);
	if (!stream) return;
	stream.controller.abort();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	await Promise.race([stream.released, timeout]);
	clearTimeout(timer);
}

export function releaseStream(conversationId: string, controller: AbortController): void {
	byController.get(controller)?.release();
	if (streams.get(conversationId)?.controller === controller) {
		streams.delete(conversationId);
	}
}

export function listActiveStreamIds(): string[] {
	return [...streams.keys()];
}

export function hasActiveStream(conversationId: string): boolean {
	return streams.has(conversationId);
}
