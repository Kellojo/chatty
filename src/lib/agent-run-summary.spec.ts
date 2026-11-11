import { describe, expect, it } from 'vitest';
import { matchesFilter, runStatusWord, summarizeRuns } from './agent-run-summary.js';
import type { AgentRun } from './types.js';

let n = 0;
function run(
	status: AgentRun['status'],
	took: number | null,
	error: string | null = null
): AgentRun {
	n++;
	return {
		id: `r${n}`,
		agentId: 'a',
		userId: 'u',
		trigger: 'manual',
		status,
		conversationId: null,
		error,
		startedAt: 1000,
		endedAt: took === null ? null : 1000 + took
	};
}

describe('summarizeRuns', () => {
	it('counts stopped and dismissed runs out of the success rate', () => {
		const s = summarizeRuns([
			run('success', 1000),
			run('success', 3000),
			run('failed', 2000, 'boom'),
			run('failed', 500, 'Stopped by user'),
			run('dismissed', 9000),
			run('running', null),
			run('awaiting_input', null)
		]);
		expect(s.finished).toBe(3);
		expect(s.succeeded).toBe(2);
		expect(s.successRate).toBeCloseTo(2 / 3);
		expect(s.medianMs).toBe(2000);
		expect(s.counts).toEqual({ all: 7, attention: 2, failed: 1, success: 2 });
	});

	it('averages the middle pair for an even count and is null without finished runs', () => {
		expect(summarizeRuns([run('success', 1000), run('success', 2000)]).medianMs).toBe(1500);
		const empty = summarizeRuns([run('running', null)]);
		expect(empty.successRate).toBeNull();
		expect(empty.medianMs).toBeNull();
	});
});

describe('matchesFilter', () => {
	it('keeps stopped runs out of the failed filter', () => {
		expect(matchesFilter(run('failed', 1, 'Stopped by user'), 'failed')).toBe(false);
		expect(matchesFilter(run('failed', 1, 'boom'), 'failed')).toBe(true);
		expect(matchesFilter(run('awaiting_input', null), 'attention')).toBe(true);
	});
});

describe('runStatusWord', () => {
	it('names stopped runs apart from failures', () => {
		expect(runStatusWord(run('failed', 1, 'Stopped by user'))).toBe('Stopped');
		expect(runStatusWord(run('failed', 1, 'boom'))).toBe('Failed');
		expect(runStatusWord(run('awaiting_input', null))).toBe('Needs you');
	});
});
