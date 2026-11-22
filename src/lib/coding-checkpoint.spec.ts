import { describe, expect, it } from 'vitest';
import { diffBlocks, readCheckpoint } from './coding-checkpoint.js';
import { groupParts } from './components/app/timeline.js';

const part = (input: unknown) => ({ type: 'dynamic-tool', toolName: 'checkpoint', input });

describe('readCheckpoint', () => {
	it('reads changed files with their line counts', () => {
		const cp = readCheckpoint(
			part({
				changes: [
					{ path: 'a.ts', kind: 'modified', additions: 3, deletions: 1 },
					{ path: 'b.ts', kind: 'added', additions: 5 },
					{ path: 'a.ts', kind: 'modified', additions: 9 },
					{ path: 'c.png', kind: 'weird' }
				]
			})
		);
		expect(cp).toEqual({
			files: [
				{ path: 'a.ts', kind: 'modified', additions: 3, deletions: 1 },
				{ path: 'b.ts', kind: 'added', additions: 5, deletions: 0 },
				{ path: 'c.png', kind: 'modified', additions: 0, deletions: 0 }
			],
			additions: 8,
			deletions: 1
		});
	});

	it('falls back to the path list of older checkpoints', () => {
		expect(readCheckpoint(part({ files: ['x/y.ts'] }))?.files[0]).toMatchObject({ path: 'x/y.ts' });
	});

	it('is null for empty checkpoints and other parts', () => {
		expect(readCheckpoint(part({ files: [], changes: [] }))).toBeNull();
		expect(
			readCheckpoint({ type: 'dynamic-tool', toolName: 'edit_files', input: { files: ['a'] } })
		).toBeNull();
	});

	it('shows a checkpoint with files as its own block, an empty one with the activity', () => {
		const blocks = groupParts([
			{ type: 'dynamic-tool', toolName: 'Read a.ts' },
			part({ files: ['a.ts'] }),
			{ type: 'dynamic-tool', toolName: 'Read b.ts' },
			part({ files: [] })
		]);
		expect(blocks.map((b) => b.type)).toEqual(['activity', 'content', 'activity']);
	});
});

describe('diffBlocks', () => {
	it('splits the bar by share of added and removed lines', () => {
		expect(diffBlocks(0, 0)).toEqual(['none', 'none', 'none', 'none', 'none']);
		expect(diffBlocks(100, 100)).toEqual(['add', 'add', 'add', 'del', 'del']);
		expect(diffBlocks(3, 1)).toEqual(['add', 'del', 'none', 'none', 'none']);
		expect(diffBlocks(1000, 0)).toEqual(['add', 'add', 'add', 'add', 'add']);
		expect(diffBlocks(1, 0)).toEqual(['add', 'none', 'none', 'none', 'none']);
		expect(diffBlocks(500, 1).filter((b) => b === 'del')).toHaveLength(1);
	});
});

describe('diffBlocks edge cases', () => {
	it('keeps one removed block when additions would fill the bar', () => {
		expect(diffBlocks(10_000, 1)).toEqual(['add', 'add', 'add', 'add', 'del']);
		expect(diffBlocks(0, 7)).toEqual(['del', 'del', 'none', 'none', 'none']);
	});
});

describe('diffBlocks with one block', () => {
	it('colours it by the side with more lines', () => {
		expect(diffBlocks(1, 1)[0]).toBe('add');
		expect(diffBlocks(0, 1)).toEqual(['del', 'none', 'none', 'none', 'none']);
	});
});
