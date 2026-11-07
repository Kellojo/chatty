import { describe, expect, it } from 'vitest';
import { parseDiffStat } from './diff.js';

const status = (overrides: Record<string, unknown> = {}) => ({
	isRepo: true,
	workingTree: { files: [], insertions: 0, deletions: 0 },
	branchChanges: { baseRef: 'main', insertions: 0, deletions: 0 },
	...overrides
});

describe('parseDiffStat', () => {
	it('prefers the branch changes against its base', () => {
		expect(
			parseDiffStat(
				status({
					branchChanges: { baseRef: 'main', insertions: 40, deletions: 7 },
					workingTree: { files: [], insertions: 3, deletions: 1 }
				})
			)
		).toEqual({ insertions: 40, deletions: 7 });
	});

	it('falls back to uncommitted changes, then to an empty diff', () => {
		expect(parseDiffStat(status({ workingTree: { insertions: 3, deletions: 1 } }))).toEqual({
			insertions: 3,
			deletions: 1
		});
		expect(parseDiffStat(status())).toEqual({ insertions: 0, deletions: 0 });
		expect(parseDiffStat(status({ branchChanges: undefined }))).toEqual({
			insertions: 0,
			deletions: 0
		});
	});

	it('returns null for non-repositories and malformed status', () => {
		expect(parseDiffStat(status({ isRepo: false }))).toBeNull();
		expect(parseDiffStat({ isRepo: true })).toBeNull();
		expect(parseDiffStat(null)).toBeNull();
	});
});
