import { config } from './config.js';
import { getDb, type Db } from './db/index.js';
import { listSoftDeletedBefore, purgeConversation } from './db/repo/conversations.js';
import { createLogger } from './logger.js';
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
