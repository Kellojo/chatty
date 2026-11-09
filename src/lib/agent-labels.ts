import type { AgentEventName, AgentRunTrigger, AgentTriggerType } from './types.js';

/** How an agent gets started, as shown in lists and the editor. */
export const TRIGGER_LABELS: Record<AgentTriggerType, string> = {
	persona: 'Persona (chat)',
	schedule: 'Schedule',
	http: 'HTTP',
	manual: 'Manual',
	event: 'Event'
};

export const EVENT_LABELS: Record<AgentEventName, string> = {
	'memory.changed': 'Memory change',
	'chat.created': 'Chat created',
	'chat.message_completed': 'Chat message completed',
	'skill.created': 'Skill created',
	'skill.updated': 'Skill updated',
	'skill.deleted': 'Skill deleted',
	'coding.thread.finished': 'Coding task finished'
};

/** What started a single run. */
export const RUN_TRIGGER_LABELS: Record<AgentRunTrigger, string> = {
	schedule: 'Scheduled',
	http: 'HTTP',
	manual: 'Manual',
	chat: 'Chat',
	event: 'Event'
};

/** 1 → "1st", 22 → "22nd", 13 → "13th". */
export function ordinal(n: number): string {
	const mod100 = n % 100;
	if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
	switch (n % 10) {
		case 1:
			return `${n}st`;
		case 2:
			return `${n}nd`;
		case 3:
			return `${n}rd`;
		default:
			return `${n}th`;
	}
}

/** "4.2s" or "3m 12s"; null while the run is still going. */
export function formatRunDuration(run: {
	startedAt: number;
	endedAt: number | null;
}): string | null {
	if (!run.endedAt) return null;
	const seconds = (run.endedAt - run.startedAt) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/**
 * A run's stored error, or null when it carries no information (runs recorded
 * before errors were serialised properly stored "[object Object]").
 */
/** A run the user stopped on purpose (stored as failed with this message by coding-runs.ts). */
export function isStoppedRun(run: { status: string; error: string | null }): boolean {
	return run.status === 'failed' && run.error === 'Stopped by user';
}

export function formatRunError(error: string | null): string | null {
	if (!error || error === '[object Object]') return null;
	return error;
}

const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;

/** Whether an agent name is a machine slug (e.g. the built-in "memory-cleanup"). */
export function isAgentSlug(name: string): boolean {
	return SLUG_RE.test(name);
}

/** Human-readable agent title: slugs become title case ("memory-cleanup" → "Memory Cleanup",
 *  like skill titles), names people typed are kept as-is. */
export function agentDisplayName(name: string): string {
	if (!isAgentSlug(name)) return name;
	return name
		.split(/[-_]+/)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}
