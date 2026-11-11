// Server-side twin of the open tab's notice decisions: the same rules
// ($lib/notifications/rules.ts) and the user's triggers decide what is pushed,
// so a push says exactly what the tab would have shown.
import { needsYouNotice, noticeForEvent, type Notice } from '$lib/notifications/rules.js';
import type { ServerEvent } from '$lib/types.js';
import type { Db } from '../db/index.js';
import { getAgent } from '../db/repo/agents.js';
import { getSidebarConversation, toPublic } from '../db/repo/conversations.js';
import { getNotificationTriggers } from '../db/repo/user-settings.js';

/** What the service worker receives; kept small (push payloads cap near 4 KB). */
export interface PushPayload {
	title: string;
	body: string;
	tag: string;
	url: string;
	kind: Notice['kind'] | 'test';
	/** When the notice arose; an open tab's popup shown since then is the same notice. */
	createdAt: number;
}

const MAX_TITLE = 120;
const MAX_BODY = 600;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function noticeForPush(db: Db, userId: string, event: ServerEvent): Notice | null {
	const triggers = getNotificationTriggers(db, userId);
	const conversation = (id: string) => {
		const row = getSidebarConversation(db, userId, id);
		return row ? toPublic(row) : undefined;
	};
	if (event.type === 'coding.task.awaiting_input') {
		if (!triggers.needsYou) return null;
		const c = conversation(event.conversationId);
		return c && c.settledAt === null ? needsYouNotice(c) : null;
	}
	const notice = noticeForEvent(event, { triggers, conversation });
	if (!notice?.agentId) return notice;
	const agent = getAgent(db, notice.agentId);
	return agent?.name ? { ...notice, title: agent.name } : notice;
}

/**
 * Whether a held question still waits for you: you may have answered it, or it
 * was dismissed, in the meantime. Other notices don't go stale this way.
 * (Read markers can't tell for replies: an open chat marks its reply read even
 * with nobody at the desk. The dispatcher checks your presence instead.)
 */
export function noticeStillWanted(db: Db, userId: string, notice: Notice): boolean {
	if (notice.kind !== 'needs-you' || !notice.conversationId) return true;
	const row = getSidebarConversation(db, userId, notice.conversationId);
	if (!row || row.settled_at !== null) return false;
	const c = toPublic(row);
	return c.agentRun?.status === 'awaiting_input' || c.coding?.status === 'awaiting_input';
}

export function toPushPayload(
	notice: Pick<Notice, 'title' | 'body' | 'tag' | 'url' | 'kind'>,
	createdAt: number
) {
	return {
		title: clip(notice.title, MAX_TITLE),
		body: clip(notice.body, MAX_BODY),
		tag: notice.tag,
		url: notice.url,
		kind: notice.kind,
		createdAt
	} satisfies PushPayload;
}
