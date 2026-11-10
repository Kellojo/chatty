// Pure decisions behind Chatty's attention signals: which server events are worth
// alerting about, how many conversations want attention, and how the tab title
// and favicon show it. Kept free of DOM and Svelte so it can be unit tested.
import type { CodingTaskStatus } from '$lib/coding-environments.js';
import type { Conversation, ServerEvent } from '$lib/types.js';
import type { NotificationTriggers } from '$lib/user-settings.js';

export type NoticeKind = 'reply' | 'needs-you' | 'finished' | 'failed';

export interface Notice {
	kind: NoticeKind;
	/** Groups notices about the same thing, so a newer one replaces the older. */
	tag: string;
	title: string;
	body: string;
	/** App path to open when the notice is clicked. */
	url: string;
	conversationId: string | null;
	/** Set for agent runs, whose name the caller may look up for the title. */
	agentId?: string;
}

export interface NoticeContext {
	triggers: NotificationTriggers;
	conversation(id: string): Conversation | undefined;
}

/** Short label for the flashing tab title. */
export const NOTICE_LABEL: Record<NoticeKind, string> = {
	reply: 'New reply',
	'needs-you': 'Needs you',
	finished: 'Task finished',
	failed: 'Failed'
};

export function conversationTitle(c: Conversation | undefined, fallback = 'New chat'): string {
	if (!c) return fallback;
	return c.title || (c.coding ? 'New task' : 'New chat');
}

/** The notice a server event should raise, or null when it isn't worth one. */
export function noticeForEvent(event: ServerEvent, ctx: NoticeContext): Notice | null {
	const { triggers } = ctx;
	switch (event.type) {
		case 'chat.message_completed': {
			// An agent run's turn: its agent.run.* event speaks for it.
			if (event.agentRunId) return null;
			if (!triggers.replies) return null;
			const c = ctx.conversation(event.conversationId);
			// Coding tasks announce themselves with coding.thread.finished; agent runs
			// with agent.run.finished.
			if (c && (c.coding || c.kind !== 'chat')) return null;
			return {
				kind: 'reply',
				tag: `chat:${event.conversationId}`,
				title: conversationTitle(c),
				body: 'New reply',
				url: `/chat/${event.conversationId}`,
				conversationId: event.conversationId
			};
		}
		case 'coding.thread.finished': {
			if (event.status === 'interrupted') return null;
			const failed = event.status === 'failed';
			if (failed ? !triggers.failures : !triggers.codingFinished) return null;
			const c = ctx.conversation(event.conversationId);
			const body = failed
				? 'Coding task failed'
				: event.prUrl
					? 'Coding task finished, pull request ready'
					: 'Coding task finished';
			return {
				kind: failed ? 'failed' : 'finished',
				tag: `chat:${event.conversationId}`,
				title: conversationTitle(c, 'Coding task'),
				body,
				url: `/chat/${event.conversationId}`,
				conversationId: event.conversationId
			};
		}
		case 'agent.run.awaiting_input': {
			if (!triggers.needsYou) return null;
			return {
				kind: 'needs-you',
				tag: `chat:${event.conversationId}`,
				title: 'Agent',
				body: `Needs you: ${event.question}`,
				url: `/chat/${event.conversationId}`,
				conversationId: event.conversationId,
				agentId: event.agentId
			};
		}
		case 'agent.run.finished': {
			// A question raises its own notice; a dismissed one needs none.
			if (
				event.status === 'running' ||
				event.status === 'awaiting_input' ||
				event.status === 'dismissed'
			) {
				return null;
			}
			const failed = event.status === 'failed';
			if (failed ? !triggers.failures : !triggers.agentRuns) return null;
			const chatId = event.visible && event.conversationId ? event.conversationId : null;
			return {
				kind: failed ? 'failed' : 'finished',
				tag: chatId ? `chat:${chatId}` : `agent-run:${event.runId}`,
				title: 'Agent',
				body: failed ? 'Agent run failed' : 'Agent run finished',
				url: chatId ? `/chat/${chatId}` : `/agents/${event.agentId}/runs/${event.runId}`,
				conversationId: chatId,
				agentId: event.agentId
			};
		}
		default:
			return null;
	}
}

/**
 * Coding tasks that started waiting for the user since the last snapshot. The
 * server announces status changes only as a bare `coding.task.updated`, so this
 * compares the refreshed conversation list against the previous one. A task
 * missing from the snapshot counts too: it is new, or just moved up into the
 * first page because it changed.
 */
export function newlyNeedingYou(
	previous: ReadonlyMap<string, CodingTaskStatus>,
	conversations: readonly Conversation[]
): Conversation[] {
	return conversations.filter(
		(c) =>
			c.coding?.status === 'awaiting_input' &&
			c.settledAt === null &&
			previous.get(c.id) !== 'awaiting_input'
	);
}

export function codingStatusSnapshot(
	conversations: readonly Conversation[]
): Map<string, CodingTaskStatus> {
	const map = new Map<string, CodingTaskStatus>();
	for (const c of conversations) if (c.coding) map.set(c.id, c.coding.status);
	return map;
}

export function needsYouNotice(c: Conversation): Notice {
	return {
		kind: 'needs-you',
		tag: `chat:${c.id}`,
		title: conversationTitle(c, 'Coding task'),
		body: 'Waiting for your input',
		url: `/chat/${c.id}`,
		conversationId: c.id
	};
}

export type AttentionLevel = 'none' | 'unread' | 'needs-you';

export interface AttentionSummary {
	count: number;
	level: AttentionLevel;
}

/**
 * Conversations asking to be looked at, matching the sidebar's dots: unread
 * replies, and tasks or agent runs waiting for input. The open conversation and
 * settled ones don't count.
 */
export function attentionSummary(
	conversations: readonly Conversation[],
	unreadIds: readonly string[],
	currentId: string | null
): AttentionSummary {
	const unread = new Set(unreadIds);
	let count = 0;
	let needsYou = false;
	for (const c of conversations) {
		if (c.id === currentId || c.settledAt !== null) continue;
		if (c.coding?.status === 'awaiting_input' || c.agentRun?.status === 'awaiting_input') {
			needsYou = true;
			count++;
		} else if (unread.has(c.id)) {
			count++;
		}
	}
	return { count, level: needsYou ? 'needs-you' : count > 0 ? 'unread' : 'none' };
}

/** The tab title: a `(n)` count, or the flashing label on alternate beats. */
export function composeTitle(
	base: string,
	count: number,
	flash: { label: string; on: boolean } | null
): string {
	if (flash?.on) return `● ${flash.label}`;
	return count > 0 ? `(${count}) ${base}` : base;
}

export const ATTENTION_DOT_COLOR: Record<Exclude<AttentionLevel, 'none'>, string> = {
	unread: '#3b82f6',
	'needs-you': '#f59e0b'
};

/** The favicon SVG with a status dot in its top-right corner. */
export function badgedFaviconSvg(svg: string, color: string): string {
	const dot = `<circle cx="19" cy="5" r="5" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>`;
	const end = svg.lastIndexOf('</svg>');
	if (end === -1) return svg;
	return svg.slice(0, end) + dot + svg.slice(end);
}

export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
