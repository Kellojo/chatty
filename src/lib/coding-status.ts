import type { CodingTaskStatus } from '$lib/coding-environments.js';

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
