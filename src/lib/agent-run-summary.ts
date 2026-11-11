import { isStoppedRun } from '$lib/agent-labels.js';
import type { AgentRun } from '$lib/types.js';

/** Which runs a filter on the runs page keeps. */
export type RunFilter = 'all' | 'attention' | 'failed' | 'success';

export interface RunSummary {
	/** Runs that finished, succeeded or not (stopped and dismissed runs excluded). */
	finished: number;
	succeeded: number;
	/** Share of finished runs that succeeded, 0–1; null when none finished. */
	successRate: number | null;
	/** Median duration of finished runs in ms; null when none finished. */
	medianMs: number | null;
	/** Runs still going or waiting for you. */
	active: number;
	counts: Record<RunFilter, number>;
}

export function matchesFilter(run: AgentRun, filter: RunFilter): boolean {
	switch (filter) {
		case 'all':
			return true;
		case 'attention':
			return run.status === 'running' || run.status === 'awaiting_input';
		case 'failed':
			return run.status === 'failed' && !isStoppedRun(run);
		case 'success':
			return run.status === 'success';
	}
}

/** A run's status in one word, as AgentRunStatus shows it. */
export function runStatusWord(run: Pick<AgentRun, 'status' | 'error'>): string {
	if (run.status === 'success') return 'Succeeded';
	if (run.status === 'running') return 'Running';
	if (run.status === 'awaiting_input') return 'Needs you';
	if (run.status === 'dismissed') return 'Dismissed';
	return isStoppedRun(run) ? 'Stopped' : 'Failed';
}

/** Aggregates for the summary above the runs list. */
export function summarizeRuns(runs: AgentRun[]): RunSummary {
	const counts: Record<RunFilter, number> = {
		all: runs.length,
		attention: 0,
		failed: 0,
		success: 0
	};
	const durations: number[] = [];
	let succeeded = 0;
	let finished = 0;
	for (const run of runs) {
		if (matchesFilter(run, 'attention')) counts.attention++;
		if (matchesFilter(run, 'failed')) counts.failed++;
		if (run.status === 'success') {
			counts.success++;
			succeeded++;
		}
		if (run.status === 'success' || matchesFilter(run, 'failed')) {
			finished++;
			if (run.endedAt) durations.push(run.endedAt - run.startedAt);
		}
	}
	durations.sort((a, b) => a - b);
	const mid = durations.length >> 1;
	const medianMs =
		durations.length === 0
			? null
			: durations.length % 2
				? durations[mid]
				: (durations[mid - 1] + durations[mid]) / 2;
	return {
		finished,
		succeeded,
		successRate: finished > 0 ? succeeded / finished : null,
		medianMs,
		active: counts.attention,
		counts
	};
}
