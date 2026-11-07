import { describeTool, toolFailed, type ToolKind } from '$lib/tool-meta.js';

/** Minimal shape of a UIMessage part, enough to group and summarise it. */
export interface PartLike {
	type: string;
	toolName?: string;
	input?: unknown;
	output?: unknown;
	state?: string;
}

export interface IndexedPart<P extends PartLike = PartLike> {
	part: P;
	/** Position in `message.parts`, stable across streaming updates. */
	index: number;
}

/**
 * A message rendered as blocks: content (text, files) shown as-is, and runs of
 * consecutive tool calls and reasoning folded into one activity block.
 */
export type TimelineBlock<P extends PartLike = PartLike> =
	| { type: 'content'; key: string; item: IndexedPart<P> }
	| { type: 'activity'; key: string; items: IndexedPart<P>[] };

export function isToolPart(part: PartLike): boolean {
	return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

function isActivity(part: PartLike): boolean {
	return part.type === 'reasoning' || isToolPart(part);
}

export function toolName(part: PartLike): string {
	return part.type === 'dynamic-tool' ? (part.toolName ?? 'tool') : part.type.slice(5);
}

export function groupParts<P extends PartLike>(parts: P[]): TimelineBlock<P>[] {
	const blocks: TimelineBlock<P>[] = [];
	parts.forEach((part, index) => {
		const item = { part, index };
		const last = blocks[blocks.length - 1];
		if (!isActivity(part)) {
			blocks.push({ type: 'content', key: `c${index}`, item });
		} else if (last?.type === 'activity') {
			last.items.push(item);
		} else {
			blocks.push({ type: 'activity', key: `a${index}`, items: [item] });
		}
	});
	return blocks;
}

const PHRASES: Partial<Record<ToolKind, [string, string]>> = {
	command: ['ran a command', 'ran {n} commands'],
	code: ['ran code', 'ran code {n} times'],
	edit: ['edited a file', 'edited {n} files'],
	read: ['read a file', 'read {n} files'],
	search: ['searched once', 'searched {n} times'],
	web: ['fetched a page', 'fetched {n} pages'],
	subagent: ['ran a subagent', 'ran {n} subagents'],
	memory: ['used memory', 'used memory {n} times'],
	math: ['did a calculation', 'did {n} calculations']
};

const ORDER = ['edit', 'command', 'code', 'subagent', 'read', 'search', 'web', 'memory', 'math'];

function priority(kind: string): number {
	const i = ORDER.indexOf(kind);
	return i === -1 ? ORDER.length : i;
}

export interface ActivitySummary {
	/** e.g. "Ran 12 commands, read 4 files, edited 3 files" */
	title: string;
	steps: number;
	failed: number;
}

export function summarizeActivity(items: IndexedPart[]): ActivitySummary {
	const counts = new Map<string, number>();
	let steps = 0;
	let failed = 0;
	let thoughts = 0;
	for (const { part } of items) {
		if (part.type === 'reasoning') {
			thoughts += 1;
			continue;
		}
		steps += 1;
		if (toolFailed(part as { state: string })) failed += 1;
		const name = toolName(part);
		const { kind } = describeTool(name, part.input);
		let n = 1;
		if (name === 'edit_files') {
			const files = (part.input as { files?: unknown } | undefined)?.files;
			n = Array.isArray(files) ? Math.max(files.length, 1) : 1;
		}
		const key = PHRASES[kind] ? kind : 'tool';
		counts.set(key, (counts.get(key) ?? 0) + n);
	}
	// Specific work first; the generic "used N tools" only fills in when space allows.
	const phrases = [...counts.entries()]
		.sort((a, b) => priority(a[0]) - priority(b[0]) || b[1] - a[1])
		.map(([kind, n]) => {
			const [one, many] = PHRASES[kind as ToolKind] ?? ['used a tool', 'used {n} tools'];
			return n === 1 ? one : many.replace('{n}', String(n));
		});
	let title: string;
	if (phrases.length === 0) title = thoughts > 0 ? 'Thought' : 'Worked';
	else if (phrases.length <= 3) title = phrases.join(', ');
	else title = `${phrases.slice(0, 2).join(', ')} and ${phrases.length - 2} more`;
	title = title.charAt(0).toUpperCase() + title.slice(1);
	return { title, steps, failed };
}

/** When a reasoning step ran, if its source recorded it (coding-agent items do). */
export interface ReasoningTiming {
	startedAt: number | null;
	completedAt: number | null;
}

export function reasoningTiming(part: PartLike): ReasoningTiming {
	const meta = (part as { providerMetadata?: { t3?: Record<string, unknown> } }).providerMetadata
		?.t3;
	const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	return { startedAt: ms(meta?.startedAt), completedAt: ms(meta?.completedAt) };
}
