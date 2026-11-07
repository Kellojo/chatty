import { listActiveStreamIds } from './chat/streams.js';
import { config } from './config.js';
import { getDb, type Db } from './db/index.js';
import {
	autoSettleConversations,
	listSoftDeletedBefore,
	purgeConversation
} from './db/repo/conversations.js';
import { publishServerEvent } from './events/bus.js';
import { createLogger } from './logger.js';
import { queueThreadStatePush } from './t3/thread-state.js';
import {
	gcAgentWorkspaces,
	gcOrphanConversationWorkspaces,
	removeConversationWorkspace
} from './workspaces.js';

const log = createLogger('jobs');

const PURGE_SOFT_DELETED_DAYS = 30;

export function purgeSoftDeletedConversations(
	db: Db,
	olderThanDays: number = PURGE_SOFT_DELETED_DAYS
): number {
	const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
	const ids = listSoftDeletedBefore(db, cutoff);
	let purged = 0;
	for (const id of ids) {
		try {
			purgeConversation(db, id);
			removeConversationWorkspace(id);
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

export function runDailyJobs(db: Db = getDb()): void {
	const purged = purgeSoftDeletedConversations(db);
	if (purged > 0) log.info(`Purged ${purged} soft-deleted conversation(s)`);

	const agentRemoved = gcAgentWorkspaces(config.WORKSPACE_GC_DAYS);
	for (const name of agentRemoved) {
		log.info(`Removed stale agent workspace ${name} (idle > ${config.WORKSPACE_GC_DAYS}d)`);
	}

	const orphanRemoved = gcOrphanConversationWorkspaces(listAllConversationIds(db));
	for (const name of orphanRemoved) {
		log.info(`Removed orphan conversation workspace ${name} (no matching conversation row)`);
	}
}

let timer: ReturnType<typeof setInterval> | null = null;

export function stopDailyJobs(): void {
	if (timer) clearInterval(timer);
	timer = null;
}

export function startDailyJobs(db: Db = getDb()): void {
	runDailyJobs(db);
	if (timer) return;
	timer = setInterval(
		() => {
			try {
				runDailyJobs(db);
			} catch (e) {
				log.error('Daily jobs failed', { error: e instanceof Error ? e.message : String(e) });
			}
		},
		24 * 60 * 60 * 1000
	);
	timer.unref?.();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Settles chats idle for CONVERSATION_AUTO_SETTLE_DAYS, skipping streaming ones. */
export function runAutoSettle(
	db: Db = getDb(),
	days: number = config.CONVERSATION_AUTO_SETTLE_DAYS
): number {
	if (days <= 0) return 0;
	const byUser = autoSettleConversations(db, {
		cutoffMs: Date.now() - days * DAY_MS,
		excludeIds: listActiveStreamIds()
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
