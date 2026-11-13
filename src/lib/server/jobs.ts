import { dismissRun } from './agents/run-lifecycle.js';
import { listActiveStreamIds } from './chat/streams.js';
import { config } from './config.js';
import { getDb, type Db } from './db/index.js';
import {
	listAwaitingAgentRunConversationIds,
	listAwaitingAgentRunsBefore
} from './db/repo/agent-runs.js';
import { deleteStalePushSubscriptions } from './db/repo/push-subscriptions.js';
import {
	deleteUnlinkedAttachment,
	listAttachmentPaths,
	listUnlinkedChatAttachments
} from './db/repo/attachments.js';
import {
	autoSettleConversations,
	listSoftDeletedBefore,
	purgeConversation,
	softDeleteConversation,
	wakeDueSnoozes
} from './db/repo/conversations.js';
import { publishServerEvent } from './events/bus.js';
import { createLogger } from './logger.js';
import { queueThreadStatePush } from './t3/thread-state.js';
import {
	attachmentFileMtime,
	gcAgentWorkspaces,
	gcOrphanConversationWorkspaces,
	listAttachmentFiles,
	removeAttachmentFile,
	removeConversationWorkspace
} from './workspaces.js';

const log = createLogger('jobs');

const PURGE_SOFT_DELETED_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function purgeSoftDeletedConversations(
	db: Db,
	olderThanDays: number = PURGE_SOFT_DELETED_DAYS
): Promise<number> {
	const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
	const ids = listSoftDeletedBefore(db, cutoff);
	let purged = 0;
	for (const id of ids) {
		try {
			purgeConversation(db, id);
			await removeConversationWorkspace(id);
			purged++;
			log.info(`Purged conversation ${id} (soft-deleted > ${olderThanDays}d ago)`);
		} catch (e) {
			log.error(`Failed to purge conversation ${id}`, {
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}
	return purged;
}

export function listAllConversationIds(db: Db): Set<string> {
	return new Set(
		(db.prepare('SELECT id FROM conversations').all() as { id: string }[]).map((r) => r.id)
	);
}

const HOUR_MS = 60 * 60 * 1000;

export interface AttachmentCleanupResult {
	/** Unsent uploads older than the cutoff (rows and their files). */
	unlinkedRows: number;
	/** Files on disk with no attachment row. */
	orphanFiles: number;
}

/**
 * Removes attachments nobody can reach: uploads never sent with a message
 * (after `unlinkedMaxAgeMs`, judged by the file's mtime since rows carry no
 * timestamp) and files whose row is gone (deleted with its message or
 * conversation). Files younger than `orphanGraceMs` are kept, since an upload
 * writes its file just before inserting the row.
 */
export async function cleanupOrphanAttachments(
	db: Db,
	options: { now?: number; unlinkedMaxAgeMs?: number; orphanGraceMs?: number } = {}
): Promise<AttachmentCleanupResult> {
	const now = options.now ?? Date.now();
	const unlinkedCutoff = now - (options.unlinkedMaxAgeMs ?? DAY_MS);
	const orphanCutoff = now - (options.orphanGraceMs ?? HOUR_MS);
	let unlinkedRows = 0;
	for (const row of listUnlinkedChatAttachments(db)) {
		const mtime = await attachmentFileMtime(row.path);
		if (mtime !== null && mtime >= unlinkedCutoff) continue;
		if (!deleteUnlinkedAttachment(db, row.id)) continue;
		if (mtime !== null) await removeAttachmentFile(row.path);
		unlinkedRows++;
	}
	const known = listAttachmentPaths(db);
	let orphanFiles = 0;
	for (const file of await listAttachmentFiles()) {
		if (known.has(file.storedPath) || file.mtimeMs >= orphanCutoff) continue;
		if (await removeAttachmentFile(file.storedPath)) orphanFiles++;
	}
	return { unlinkedRows, orphanFiles };
}

/** Dismisses agent questions nobody answered within `days`. */
export function expireAgentQuestions(
	db: Db = getDb(),
	days: number = config.AGENT_QUESTION_TTL_DAYS
): number {
	if (days <= 0) return 0;
	let expired = 0;
	for (const run of listAwaitingAgentRunsBefore(db, Date.now() - days * DAY_MS)) {
		if (dismissRun(db, run, `Dismissed: no answer within ${days} days`)) expired++;
	}
	if (expired > 0) log.info(`Dismissed ${expired} unanswered agent question(s)`);
	return expired;
}

/**
 * Deletes (to trash) settled agent-run chats the user never replied to, after
 * `days`: a frequent scheduled agent would otherwise fill the settled shelf.
 */
export function pruneAgentRunChats(
	db: Db = getDb(),
	days: number = config.AGENT_RUN_CHAT_RETENTION_DAYS
): number {
	if (days <= 0) return 0;
	const rows = db
		.prepare(
			`SELECT c.id, c.user_id FROM conversations c
			 WHERE c.origin = 'dispatch' AND c.deleted_at IS NULL AND c.pinned = 0
			   AND c.settled_at IS NOT NULL AND c.settled_at < ?
			   AND NOT EXISTS (
			     SELECT 1 FROM agent_runs r
			     WHERE r.conversation_id = c.id AND r.status IN ('running', 'awaiting_input')
			   )
			   AND (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') <= 1`
		)
		.all(Date.now() - days * DAY_MS) as { id: string; user_id: string }[];
	let pruned = 0;
	for (const row of rows) {
		if (!softDeleteConversation(db, row.user_id, row.id)) continue;
		publishServerEvent(row.user_id, { type: 'conversation.deleted', conversationId: row.id });
		pruned++;
	}
	if (pruned > 0)
		log.info(`Moved ${pruned} untouched agent-run chat(s) older than ${days}d to trash`);
	return pruned;
}

export async function runDailyJobs(db: Db = getDb()): Promise<void> {
	expireAgentQuestions(db);
	pruneAgentRunChats(db);

	const purged = await purgeSoftDeletedConversations(db);
	if (purged > 0) log.info(`Purged ${purged} soft-deleted conversation(s)`);

	const stalePush = deleteStalePushSubscriptions(db);
	if (stalePush > 0) log.info(`Removed ${stalePush} push subscription(s) of ended sessions`);

	const agentRemoved = await gcAgentWorkspaces(config.WORKSPACE_GC_DAYS);
	for (const name of agentRemoved) {
		log.info(`Removed stale agent workspace ${name} (idle > ${config.WORKSPACE_GC_DAYS}d)`);
	}

	const orphanRemoved = await gcOrphanConversationWorkspaces(() => listAllConversationIds(db));
	for (const name of orphanRemoved) {
		log.info(`Removed orphan conversation workspace ${name} (no matching conversation row)`);
	}

	const attachments = await cleanupOrphanAttachments(db);
	if (attachments.unlinkedRows > 0 || attachments.orphanFiles > 0) {
		log.info(
			`Removed ${attachments.unlinkedRows} unsent attachment(s) and ${attachments.orphanFiles} orphaned attachment file(s)`
		);
	}
}

let timer: ReturnType<typeof setInterval> | null = null;

export function stopDailyJobs(): void {
	if (timer) clearInterval(timer);
	timer = null;
}

export function startDailyJobs(db: Db = getDb()): void {
	const run = () =>
		runDailyJobs(db).catch((e: unknown) => {
			log.error('Daily jobs failed', { error: e instanceof Error ? e.message : String(e) });
		});
	void run();
	if (timer) return;
	timer = setInterval(() => void run(), DAY_MS);
	timer.unref?.();
}

/** Settles chats idle for CONVERSATION_AUTO_SETTLE_DAYS, skipping streaming ones. */
export function runAutoSettle(
	db: Db = getDb(),
	days: number = config.CONVERSATION_AUTO_SETTLE_DAYS
): number {
	if (days <= 0) return 0;
	const byUser = autoSettleConversations(db, {
		cutoffMs: Date.now() - days * DAY_MS,
		// A chat whose agent waits for an answer is only dismissed by its own
		// expiry (expireAgentQuestions), never silently by auto-settle.
		excludeIds: [...listActiveStreamIds(), ...listAwaitingAgentRunConversationIds(db)]
	});
	let total = 0;
	for (const [userId, conversationIds] of byUser) {
		total += conversationIds.length;
		publishServerEvent(userId, {
			type: 'conversation.settle_changed',
			conversationIds,
			settled: true
		});
		queueThreadStatePush(db, userId, conversationIds);
	}
	if (total > 0) log.info(`Auto-settled ${total} conversation(s) idle > ${days}d`);
	return total;
}

let hourlyTimer: ReturnType<typeof setInterval> | null = null;

export function stopHourlyJobs(): void {
	if (hourlyTimer) clearInterval(hourlyTimer);
	hourlyTimer = null;
}

export function startHourlyJobs(db: Db = getDb()): void {
	const run = () => {
		try {
			runAutoSettle(db);
		} catch (e) {
			log.error('Hourly jobs failed', { error: e instanceof Error ? e.message : String(e) });
		}
	};
	run();
	if (hourlyTimer) return;
	hourlyTimer = setInterval(run, 60 * 60 * 1000);
	hourlyTimer.unref?.();
}

/** Brings back snoozed chats whose time has come. Returns how many woke. */
export function runSnoozeWake(db: Db = getDb(), now = Date.now()): number {
	let total = 0;
	for (const [userId, conversationIds] of wakeDueSnoozes(db, now)) {
		total += conversationIds.length;
		publishServerEvent(userId, {
			type: 'conversation.snooze_changed',
			conversationIds,
			snoozed: false
		});
	}
	return total;
}

/** How often due snoozes are checked: a chat wakes at most this late. */
const SNOOZE_WAKE_INTERVAL_MS = 30 * 1000;

let snoozeTimer: ReturnType<typeof setInterval> | null = null;

export function stopSnoozeWaker(): void {
	if (snoozeTimer) clearInterval(snoozeTimer);
	snoozeTimer = null;
}

export function startSnoozeWaker(db: Db = getDb()): void {
	const run = () => {
		try {
			runSnoozeWake(db);
		} catch (e) {
			log.error('Waking snoozed chats failed', {
				error: e instanceof Error ? e.message : String(e)
			});
		}
	};
	run();
	if (snoozeTimer) return;
	snoozeTimer = setInterval(run, SNOOZE_WAKE_INTERVAL_MS);
	snoozeTimer.unref?.();
}
