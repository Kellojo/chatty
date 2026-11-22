// A coding agent's checkpoint: the files one of its runs changed, as T3 reports
// them (see the `checkpoint` case in server/t3/projection.ts). Shown as its own
// card under the reply, so the changes are easy to see and open.

import type { PartLike } from '$lib/components/app/timeline.js';

export type CheckpointFileKind = 'added' | 'deleted' | 'modified';

export interface CheckpointFile {
	/** Path inside the task's workspace, as T3 names it. */
	path: string;
	kind: CheckpointFileKind;
	additions: number;
	deletions: number;
}

export interface Checkpoint {
	files: CheckpointFile[];
	additions: number;
	deletions: number;
}

const KINDS = new Set<string>(['added', 'deleted', 'modified']);
const count = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);

export function isCheckpointPart(part: PartLike): boolean {
	return part.type === 'dynamic-tool' && part.toolName === 'checkpoint';
}

/** The checkpoint's files, or null when the part isn't one or changed nothing. */
export function readCheckpoint(part: PartLike): Checkpoint | null {
	if (!isCheckpointPart(part)) return null;
	const input =
		part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {};
	const changes = Array.isArray(input.changes) ? input.changes : [];
	// Older checkpoints list paths only.
	const listed =
		changes.length > 0
			? changes
			: Array.isArray(input.files)
				? input.files.map((path) => ({ path }))
				: [];
	const files: CheckpointFile[] = [];
	const seen = new Set<string>();
	for (const entry of listed) {
		const f = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
		const path = typeof f.path === 'string' ? f.path.trim() : '';
		if (!path || seen.has(path)) continue;
		seen.add(path);
		files.push({
			path,
			kind:
				typeof f.kind === 'string' && KINDS.has(f.kind)
					? (f.kind as CheckpointFileKind)
					: 'modified',
			additions: count(f.additions),
			deletions: count(f.deletions)
		});
	}
	if (files.length === 0) return null;
	return {
		files,
		additions: files.reduce((n, f) => n + f.additions, 0),
		deletions: files.reduce((n, f) => n + f.deletions, 0)
	};
}

/**
 * Five blocks showing the share of added vs removed lines, like GitHub's
 * diffstat: `['add','add','add','del','none']`. All `none` for no line changes.
 */
export function diffBlocks(
	additions: number,
	deletions: number,
	blocks = 5
): ('add' | 'del' | 'none')[] {
	const total = additions + deletions;
	if (total === 0) return Array.from({ length: blocks }, () => 'none' as const);
	// Small changes don't fill the bar.
	const filled = Math.min(blocks, Math.max(1, Math.ceil(Math.log10(total + 1) * 2)));
	// One block takes the side with more lines.
	if (filled === 1) {
		const one = additions >= deletions ? 'add' : 'del';
		return Array.from({ length: blocks }, (_, i) => (i === 0 ? one : 'none'));
	}
	let adds = Math.round((additions / total) * filled);
	if (additions > 0 && adds === 0) adds = 1;
	if (deletions > 0 && adds === filled) adds = filled - 1;
	return Array.from({ length: blocks }, (_, i) => (i < adds ? 'add' : i < filled ? 'del' : 'none'));
}
