// A coding task's change size (+/- lines), read from T3 Code's VCS status for
// the thread's worktree (`vcs.refreshStatus`).

import type { CodingDiffStat } from '$lib/coding-environments.js';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;

function stat(value: unknown): CodingDiffStat | null {
	const v = rec(value);
	const insertions = v?.insertions;
	const deletions = v?.deletions;
	if (typeof insertions !== 'number' || typeof deletions !== 'number') return null;
	return { insertions: Math.max(0, insertions), deletions: Math.max(0, deletions) };
}

const nonEmpty = (s: CodingDiffStat | null) => s !== null && (s.insertions > 0 || s.deletions > 0);

/**
 * Same choice T3's own UI makes: the branch's changes against its base when
 * there are any, else uncommitted working-tree changes. Null if the status
 * isn't a git repository or can't be read.
 */
export function parseDiffStat(status: unknown): CodingDiffStat | null {
	const s = rec(status);
	if (!s || s.isRepo === false) return null;
	const branch = stat(s.branchChanges);
	const workingTree = stat(s.workingTree);
	if (nonEmpty(branch)) return branch;
	if (nonEmpty(workingTree)) return workingTree;
	return branch ?? workingTree;
}
