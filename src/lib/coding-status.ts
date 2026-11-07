import type { CodingPullRequestState, CodingTaskStatus } from '$lib/coding-environments.js';

/**
 * How a coding task's status is shown: one quiet style for every state, a dot
 * plus muted text, tinted only when it needs you.
 */
export const CODING_STATUS_STYLE: Record<
	CodingTaskStatus,
	{ label: string; dot: string; tone: string }
> = {
	starting: { label: 'Starting', dot: 'bg-info animate-pulse', tone: 'text-muted-foreground' },
	running: { label: 'Working', dot: 'bg-info animate-pulse', tone: 'text-muted-foreground' },
	awaiting_input: {
		label: 'Waiting for you',
		dot: 'bg-amber-500',
		tone: 'text-amber-700 dark:text-amber-400'
	},
	idle: { label: 'Idle', dot: 'bg-muted-foreground', tone: 'text-muted-foreground' },
	failed: { label: 'Failed', dot: 'bg-destructive', tone: 'text-destructive' },
	interrupted: { label: 'Interrupted', dot: 'bg-muted-foreground', tone: 'text-muted-foreground' }
};

export function isCodingTaskStatus(value: unknown): value is CodingTaskStatus {
	return typeof value === 'string' && Object.hasOwn(CODING_STATUS_STYLE, value);
}

/** How a pull request's state is shown: GitHub's familiar colours, on the icon only. */
export const CODING_PR_STATE_STYLE: Record<
	CodingPullRequestState,
	{ label: string; tone: string }
> = {
	open: { label: 'Open', tone: 'text-emerald-600 dark:text-emerald-400' },
	draft: { label: 'Draft', tone: 'text-muted-foreground' },
	merged: { label: 'Merged', tone: 'text-violet-600 dark:text-violet-400' },
	closed: { label: 'Closed', tone: 'text-destructive' }
};
