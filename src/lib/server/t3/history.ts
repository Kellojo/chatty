// Manual import of past T3 Code threads. The periodic thread sync only imports
// threads active since the environment was connected; this lets the user pick
// older (or archived, or previously deleted) ones and bring them into Chatty
// as coding conversations, with their full history.

import { MAX_HISTORY_IMPORT, type CodingHistoryThread } from '$lib/coding-environments.js';
import type { Db } from '../db/index.js';
import {
	importCodingConversation,
	listDismissedThreadIds,
	listLinkedThreadIds,
	undismissThreads
} from '../db/repo/coding-conversations.js';
import type { CodingEnvironmentRow } from '../db/repo/coding-environments.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { T3ClientError } from './client.js';
import { ensureFollower } from './follower.js';
import {
	MAX_IMPORTS_PER_PASS,
	isCurrentEnvironment,
	loadShell,
	parseImportableThread,
	shellProjects,
	type ImportableThread
} from './thread-sync.js';

const log = createLogger('t3-history');

/** Pause between batches of followers loading imported histories. */
export const FOLLOW_BATCH_DELAY_MS = 3000;

export interface HistoryThread extends ImportableThread {
	archived: boolean;
	dismissed: boolean;
}

const rec = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Threads in a shell snapshot (live and archived) that could be imported and
 * aren't linked to a conversation yet, newest first. Threads dismissed (their
 * conversation deleted) are included and flagged: importing by hand is a
 * deliberate choice.
 */
export function historyThreads(
	shell: unknown,
	opts: { linked: ReadonlySet<string>; dismissed: ReadonlySet<string> }
): HistoryThread[] {
	const s = rec(shell);
	const projects = shellProjects(s);
	const seen = new Set<string>();
	const result: HistoryThread[] = [];
	for (const entry of [...list(s?.threads), ...list(s?.archivedThreads)]) {
		const thread = parseImportableThread(entry, projects);
		if (!thread || opts.linked.has(thread.threadId) || seen.has(thread.threadId)) continue;
		seen.add(thread.threadId);
		result.push({
			...thread,
			archived: Boolean(rec(entry)?.archivedAt),
			dismissed: opts.dismissed.has(thread.threadId)
		});
	}
	return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function toPublicHistoryThread(thread: HistoryThread): CodingHistoryThread {
	return {
		threadId: thread.threadId,
		title: thread.title,
		projectTitle: thread.projectTitle,
		model: thread.model,
		updatedAt: thread.updatedAt,
		archived: thread.archived,
		dismissed: thread.dismissed
	};
}

async function loadHistory(db: Db, env: CodingEnvironmentRow): Promise<HistoryThread[]> {
	const shell = await loadShell(env);
	// The environment may have been disabled, edited or removed meanwhile.
	if (!isCurrentEnvironment(db, env)) {
		throw new T3ClientError('The coding environment changed, try again', 'remote');
	}
	return historyThreads(shell, {
		linked: listLinkedThreadIds(db, env.id),
		dismissed: listDismissedThreadIds(db, env.id)
	});
}

/** Past threads on `env` that can be imported. Throws T3ClientError when unreachable. */
export async function listHistoryThreads(
	db: Db,
	env: CodingEnvironmentRow
): Promise<CodingHistoryThread[]> {
	return (await loadHistory(db, env)).map(toPublicHistoryThread);
}

/**
 * Imports the given threads of `env` (at most MAX_HISTORY_IMPORT; ids that
 * aren't importable, e.g. already imported meanwhile, are skipped) and starts
 * loading their history. Returns the new conversation ids.
 */
export async function importHistoryThreads(
	db: Db,
	env: CodingEnvironmentRow,
	threadIds: readonly string[]
): Promise<string[]> {
	const wanted = new Set(threadIds.slice(0, MAX_HISTORY_IMPORT));
	const threads = (await loadHistory(db, env)).filter((t) => wanted.has(t.threadId));
	// Synchronous from here on, so a concurrent import can't link a thread twice.
	const imported = threads.map((thread) => ({
		threadId: thread.threadId,
		conversationId: importCodingConversation(db, {
			userId: env.user_id,
			environmentId: env.id,
			baseBranch: null,
			...thread
		})
	}));
	undismissThreads(
		db,
		env.id,
		threads.filter((t) => t.dismissed).map((t) => t.threadId)
	);
	for (const { conversationId } of imported) {
		publishServerEvent(env.user_id, { type: 'conversation.updated', conversationId });
	}
	followImported(db, env, imported);
	if (imported.length > 0) {
		log.info(`Imported ${imported.length} past thread(s) from T3`, { environmentId: env.id });
	}
	return imported.map((i) => i.conversationId);
}

/**
 * Loads the imported histories a batch at a time, so a large import doesn't
 * open a socket per thread at once. Every follower is registered right away,
 * so the periodic sync doesn't start a (non-quiet) one of its own meanwhile;
 * one stopped in between (environment changed) ignores its late `follow()`.
 */
function followImported(
	db: Db,
	env: CodingEnvironmentRow,
	items: readonly { conversationId: string; threadId: string }[]
): void {
	const followers = items.map((item) =>
		ensureFollower({ ...item, userId: env.user_id, env, quietHistory: true })
	);
	const next = (start: number) => {
		if (start > 0 && !isCurrentEnvironment(db, env)) return;
		for (const follower of followers.slice(start, start + MAX_IMPORTS_PER_PASS)) {
			void follower.follow();
		}
		if (start + MAX_IMPORTS_PER_PASS >= followers.length) return;
		const timer = setTimeout(() => next(start + MAX_IMPORTS_PER_PASS), FOLLOW_BATCH_DELAY_MS);
		timer.unref?.();
	};
	next(0);
}
