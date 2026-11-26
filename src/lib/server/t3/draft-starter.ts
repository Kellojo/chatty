// Starts draft coding tasks (saved while their environment was unreachable) by
// themselves once the environment answers again. Only drafts with auto-start on
// are tried; the check is the start itself, so an environment that is still
// offline costs one failed request per pass, and none when no draft waits.

import { getDb, type Db } from '../db/index.js';
import {
	listAutoStartDrafts,
	setCodingDraftAutoStart,
	updateCodingConversation
} from '../db/repo/coding-conversations.js';
import { countMessages } from '../db/repo/messages.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { CodingTaskError, startCodingDraft } from './tasks.js';

const log = createLogger('t3-drafts');

/** How often waiting drafts are tried while their environment is offline. */
export const DRAFT_RETRY_MS = 60_000;

/** The environment couldn't be reached (or refused the token): try again later. */
const isUnreachable = (e: CodingTaskError) => e.status >= 500 || e.status === 403;

let pass: Promise<void> | null = null;

/**
 * Tries every waiting draft once, oldest first; one unreachable draft skips the
 * rest on its environment. A draft whose target no longer works (project gone,
 * environment disabled) stops auto-starting and shows why.
 */
export function startWaitingDrafts(db: Db = getDb()): Promise<void> {
	pass ??= runPass(db).finally(() => (pass = null));
	return pass;
}

async function runPass(db: Db): Promise<void> {
	const unreachable = new Set<string>();
	for (const draft of listAutoStartDrafts(db)) {
		if (unreachable.has(draft.environment_id)) continue;
		// Just created: its message is still on the way from the chat page.
		if (countMessages(db, draft.conversation_id) === 0) continue;
		try {
			await startCodingDraft(draft.user_id, draft.conversation_id, db);
			log.info('Started a draft coding task', { conversationId: draft.conversation_id });
		} catch (e) {
			if (!(e instanceof CodingTaskError)) {
				log.error('Could not start a draft coding task', {
					conversationId: draft.conversation_id,
					error: e instanceof Error ? e.message : String(e)
				});
				continue;
			}
			if (isUnreachable(e)) {
				unreachable.add(draft.environment_id);
				continue;
			}
			// Only while it's still a draft: a launch that failed after starting
			// already recorded its own error.
			if (setCodingDraftAutoStart(db, draft.conversation_id, false)) {
				updateCodingConversation(db, draft.conversation_id, { lastError: e.message });
				publishServerEvent(draft.user_id, {
					type: 'coding.task.updated',
					conversationId: draft.conversation_id
				});
			}
		}
	}
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDraftStarter(db: Db = getDb()): void {
	if (timer) return;
	const tick = () => {
		startWaitingDrafts(db).catch((e) =>
			log.error('Draft coding task pass failed', {
				error: e instanceof Error ? e.message : String(e)
			})
		);
	};
	tick();
	timer = setInterval(tick, DRAFT_RETRY_MS);
	timer.unref?.();
}

export function stopDraftStarter(): void {
	if (timer) clearInterval(timer);
	timer = null;
}
