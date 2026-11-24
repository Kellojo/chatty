// A coding agent compacting its context: T3's `compaction` item (see the
// `compaction` case in server/t3/projection.ts). Shown as its own row in the
// reply rather than folded into the activity, so it's clear why the agent went
// quiet and that its context was summarised.

import type { PartLike } from '$lib/components/app/timeline.js';

export interface Compaction {
	state: 'running' | 'done' | 'stopped';
	startedAt: number | null;
	completedAt: number | null;
	/** Context size before and after, in tokens, when the agent reports them. */
	beforeTokens: number | null;
	afterTokens: number | null;
}

const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tokens = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function isCompactionPart(part: PartLike): boolean {
	return part.type === 'dynamic-tool' && part.toolName === 'compaction';
}

export function readCompaction(part: PartLike): Compaction | null {
	if (!isCompactionPart(part)) return null;
	const input =
		part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {};
	return {
		state:
			part.state === 'output-error'
				? 'stopped'
				: part.state === 'output-available'
					? 'done'
					: 'running',
		startedAt: ms(input.startedAt),
		completedAt: ms(input.completedAt),
		beforeTokens: tokens(input.beforeTokens),
		afterTokens: tokens(input.afterTokens)
	};
}
