import type { UIMessageChunk } from 'ai';

const MAX_CHUNKS = 2000;

interface ActiveStream {
	controller: AbortController;
	chunks: UIMessageChunk[];
	listeners: Set<(chunk: UIMessageChunk) => void>;
	done: boolean;
}

const streams = new Map<string, ActiveStream>();

export function registerStream(conversationId: string, controller: AbortController): void {
	streams.get(conversationId)?.controller.abort();
	streams.set(conversationId, { controller, chunks: [], listeners: new Set(), done: false });
}

export function appendChunk(conversationId: string, chunk: UIMessageChunk): void {
	const stream = streams.get(conversationId);
	if (!stream) return;
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

export function markDone(conversationId: string): void {
	const stream = streams.get(conversationId);
	if (stream) stream.done = true;
}

export function abortStream(conversationId: string): boolean {
	const stream = streams.get(conversationId);
	if (!stream) return false;
	stream.controller.abort();
	return true;
}

export function releaseStream(conversationId: string, controller: AbortController): void {
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
