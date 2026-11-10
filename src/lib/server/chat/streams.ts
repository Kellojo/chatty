import type { UIMessageChunk } from 'ai';

// Consecutive deltas are merged (see `pushChunk`), so this bounds structural
// chunks (part starts/ends, tool calls/results), not tokens.
const MAX_CHUNKS = 20_000;

interface ActiveStream {
	controller: AbortController;
	/** When the turn started (ms), for the sidebar's "running for" timer. */
	startedAt: number;
	chunks: UIMessageChunk[];
	// Set once the replay buffer outgrew MAX_CHUNKS. An incomplete replay would
	// hand reconnecting clients a message with a hole in it, so replay is then
	// refused and they fall back to the periodically persisted copy.
	overflowed: boolean;
	listeners: Set<(chunk: UIMessageChunk) => void>;
	done: boolean;
	released: Promise<void>;
	release: () => void;
}

const DEFAULT_ABORT_WAIT_MS = 5000;

/**
 * Why a stream was aborted, passed as the controller's abort reason. Turns that
 * belong to an agent run map it to the run's error; chat replies show
 * "Response interrupted" whatever the reason.
 */
export type AbortReason = 'superseded' | 'stopped' | 'shutdown';

/** The reason a stream was aborted with, or null when it wasn't (or by someone else). */
export function abortReasonOf(signal: AbortSignal): AbortReason | null {
	if (!signal.aborted) return null;
	const reason: unknown = signal.reason;
	return reason === 'superseded' || reason === 'stopped' || reason === 'shutdown' ? reason : null;
}

// Kept on globalThis so a dev-server hot reload of this module doesn't lose
// streams that are still open (the sidebar would then miss their finish).
const globalState = globalThis as {
	__chatStreams?: {
		streams: Map<string, ActiveStream>;
		byController: WeakMap<AbortController, ActiveStream>;
	};
};
globalState.__chatStreams ??= { streams: new Map(), byController: new WeakMap() };
const streams = globalState.__chatStreams.streams;
// Keyed by controller rather than conversation: a replaced stream is gone from
// `streams` but still finishes later, and anyone waiting on it must be told.
const byController = globalState.__chatStreams.byController;

export function registerStream(conversationId: string, controller: AbortController): void {
	streams.get(conversationId)?.controller.abort('superseded' satisfies AbortReason);
	let release = () => {};
	const released = new Promise<void>((resolve) => (release = resolve));
	const stream: ActiveStream = {
		controller,
		startedAt: Date.now(),
		chunks: [],
		overflowed: false,
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
	if (!stream.overflowed) {
		pushChunk(stream.chunks, chunk);
		if (stream.chunks.length > MAX_CHUNKS) {
			stream.overflowed = true;
			stream.chunks = [];
		}
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
	if (!stream || stream.overflowed) return null;
	return { chunks: [...stream.chunks], done: stream.done };
}

/**
 * Appends to a replay buffer, folding a delta into the previous chunk when it
 * continues the same text/reasoning part or tool input. Replaying the merged
 * chunk reconstructs the identical message, and a long transcript then costs
 * roughly its own size instead of one chunk per token. Chunks are copied, never
 * mutated, since listeners received the originals.
 */
export function pushChunk(chunks: UIMessageChunk[], chunk: UIMessageChunk): void {
	const last = chunks.at(-1);
	if (last) {
		if (
			(chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
			last.type === chunk.type &&
			last.id === chunk.id &&
			!last.providerMetadata &&
			!chunk.providerMetadata
		) {
			chunks[chunks.length - 1] = { ...last, delta: last.delta + chunk.delta };
			return;
		}
		if (
			chunk.type === 'tool-input-delta' &&
			last.type === 'tool-input-delta' &&
			last.toolCallId === chunk.toolCallId
		) {
			chunks[chunks.length - 1] = {
				...last,
				inputTextDelta: last.inputTextDelta + chunk.inputTextDelta
			};
			return;
		}
		// A running tool's input re-sent (e.g. subagent progress): only the latest counts.
		if (
			chunk.type === 'tool-input-available' &&
			last.type === 'tool-input-available' &&
			last.toolCallId === chunk.toolCallId
		) {
			chunks[chunks.length - 1] = { ...chunk };
			return;
		}
	}
	chunks.push(chunk);
}

export function markDone(conversationId: string, owner?: AbortController): void {
	const stream = streams.get(conversationId);
	if (stream && (!owner || stream.controller === owner)) stream.done = true;
}

export function abortStream(conversationId: string, reason: AbortReason = 'stopped'): boolean {
	const stream = streams.get(conversationId);
	if (!stream) return false;
	stream.controller.abort(reason);
	return true;
}

/**
 * Aborts the running stream, if any, and waits until it has persisted its partial
 * message and been released, so that a new request sees the final history. The
 * wait is bounded so a stuck stream can't block new messages.
 */
export async function abortStreamAndWait(
	conversationId: string,
	reason: AbortReason,
	timeoutMs = DEFAULT_ABORT_WAIT_MS
): Promise<void> {
	const stream = streams.get(conversationId);
	if (!stream) return;
	stream.controller.abort(reason);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	await Promise.race([stream.released, timeout]);
	clearTimeout(timer);
}

/**
 * Takes over a conversation for a new response: aborts and waits for whatever
 * is running (bounded, as in `abortStreamAndWait`), then registers a fresh
 * controller with no await in between, so a concurrent request always sees
 * this claim and in turn aborts/waits for it. The caller owns the claim and
 * must `releaseStream` it on every path.
 */
export async function claimStream(
	conversationId: string,
	timeoutMs = DEFAULT_ABORT_WAIT_MS
): Promise<AbortController> {
	const deadline = Date.now() + timeoutMs;
	// Another request may claim while we wait, so re-check after every wait.
	while (streams.has(conversationId)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await abortStreamAndWait(conversationId, 'superseded', remaining);
	}
	const controller = new AbortController();
	registerStream(conversationId, controller);
	return controller;
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

/** Active streams with their start times (ms). */
export function listActiveStreams(): Array<{ conversationId: string; startedAt: number }> {
	return [...streams].map(([conversationId, s]) => ({ conversationId, startedAt: s.startedAt }));
}

export function getStreamStartedAt(conversationId: string): number | null {
	return streams.get(conversationId)?.startedAt ?? null;
}

export function hasActiveStream(conversationId: string): boolean {
	return streams.has(conversationId);
}
