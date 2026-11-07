import type { ChatMessage } from './types.js';

/**
 * The message to resume an incremental transcript fetch from: the first one
 * still streaming, otherwise the last one (it may yet be followed or settled).
 * Everything before it is final and need not be fetched again.
 */
export function transcriptCursor(messages: readonly ChatMessage[]): string | null {
	const partial = messages.find((m) => m.status === 'partial');
	return (partial ?? messages.at(-1))?.id ?? null;
}

/**
 * Merges a fetched transcript slice into the current one. `from` is the
 * anchor the server used: the slice replaces everything from that message on,
 * which also drops messages removed server-side. `from: null` means the slice
 * is the full transcript.
 */
export function mergeTranscript(
	current: readonly ChatMessage[],
	from: string | null,
	slice: ChatMessage[]
): ChatMessage[] {
	if (from === null) return slice;
	const index = current.findIndex((m) => m.id === from);
	if (index !== -1) return [...current.slice(0, index), ...slice];
	// Anchor unknown locally (shouldn't happen): upsert by id to stay consistent.
	const byId = new Map(slice.map((m) => [m.id, m]));
	const kept = current.map((m) => byId.get(m.id) ?? m);
	const known = new Set(current.map((m) => m.id));
	return [...kept, ...slice.filter((m) => !known.has(m.id))];
}
