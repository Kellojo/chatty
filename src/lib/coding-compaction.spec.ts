import { describe, expect, it } from 'vitest';
import { readCompaction } from './coding-compaction.js';
import { groupParts } from './components/app/timeline.js';

const part = (state: string, input: unknown = {}) => ({
	type: 'dynamic-tool',
	toolName: 'compaction',
	state,
	input
});

describe('readCompaction', () => {
	it('reads the state, timing and token counts', () => {
		expect(readCompaction(part('input-available', { startedAt: 1000 }))).toEqual({
			state: 'running',
			startedAt: 1000,
			completedAt: null,
			beforeTokens: null,
			afterTokens: null
		});
		expect(
			readCompaction(
				part('output-available', { startedAt: 1, completedAt: 2, beforeTokens: 9, afterTokens: 3 })
			)
		).toMatchObject({ state: 'done', beforeTokens: 9, afterTokens: 3 });
		expect(readCompaction(part('output-error'))?.state).toBe('stopped');
	});

	it('is null for other parts', () => {
		expect(readCompaction({ type: 'dynamic-tool', toolName: 'Read' })).toBeNull();
		expect(readCompaction({ type: 'text' })).toBeNull();
	});

	it('shows as its own block, not folded into the activity', () => {
		const blocks = groupParts([
			{ type: 'dynamic-tool', toolName: 'Read a.ts' },
			part('input-available'),
			{ type: 'dynamic-tool', toolName: 'Read b.ts' }
		]);
		expect(blocks.map((b) => b.type)).toEqual(['activity', 'content', 'activity']);
	});
});
