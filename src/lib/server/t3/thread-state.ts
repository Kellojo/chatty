// Two-way sync of a coding task's conversation state with its T3 Code thread:
// title (rename), pinned, settled and read state.
//
// Title, pinned and settled use a three-way merge: `coding_conversations.remote_*`
// hold the value both sides last agreed on, so whichever side moved since then
// wins (T3 when both did). A push that fails leaves the agreed value unchanged,
// so the next reconcile retries it.
//
// Read state compares "last looked at" times instead: Chatty's `last_read_at`
// and T3's `lastVisitedAt`, where T3 counts a thread unread while its latest
// run completed after the last visit.
// - Chatty read it after T3's latest run completed → push a visit to T3.
// - T3 says read (and nothing is running) → mark read here.
// - T3 says unread and Chatty hasn't read past that run, or T3's lastVisitedAt
//   moved backwards (T3's "mark unread") → mark unread here.
//
// T3 → Chatty arrives through the task's follower (live thread events) and the
// periodic pass in ./thread-sync.ts; Chatty → T3 is pushed whenever Chatty
// changes one of these on a coding conversation (see queueThreadStatePush).

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import {
	getCodingConversation,
	updateCodingConversation,
	type CodingConversationPatch,
	type CodingConversationRow
} from '../db/repo/coding-conversations.js';
import { getCodingEnvironment } from '../db/repo/coding-environments.js';
import {
	getConversation,
	latestAssistantMessageAt,
	setConversationPinned,
	setConversationReadAt,
	settleConversation,
	unsettleConversation,
	updateConversation,
	type ConversationRow
} from '../db/repo/conversations.js';
import { onRunConversationSettled, onRunConversationUnsettled } from '../agents/run-lifecycle.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import type { T3Connection } from './client.js';
import { withT3Connection } from './pool.js';

const log = createLogger('t3-thread-state');

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
const time = (v: unknown): number | null => {
	const ms = typeof v === 'string' ? Date.parse(v) : NaN;
	return Number.isNaN(ms) ? null : ms;
};

/** Longest thread title adopted from T3 (the remote server controls it). */
export const MAX_THREAD_TITLE_CHARS = 200;

/** Trimmed, length-capped title; null when blank or not a string. */
export function threadTitle(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const title = value.trim().slice(0, MAX_THREAD_TITLE_CHARS).trim();
	return title || null;
}

export interface RemoteReadState {
	/** `lastVisitedAt` in ms, 0 if the thread was never visited. */
	visitedAt: number;
	/** When the thread's latest run completed; null while it runs or if it never ran. */
	completedAt: number | null;
	running: boolean;
}

/** What a T3 thread record says about the synced fields; null = the record doesn't say. */
export interface RemoteThreadState {
	title: string | null;
	pinned: boolean | null;
	settled: boolean | null;
	read: RemoteReadState | null;
}

/** Settled state of a T3 thread record, or null if the record doesn't say. */
export function threadSettled(thread: unknown): boolean | null {
	const t = rec(thread);
	if (!t) return null;
	if ('settledAt' in t) return t.settledAt !== null && t.settledAt !== undefined;
	if (typeof t.settled === 'boolean') return t.settled;
	return null;
}

/**
 * Reads the synced fields off a T3 thread record (shell or full thread).
 * `runs` overrides the record's run summary, for callers that track the runs
 * themselves (the follower's full thread doesn't carry it).
 */
export function remoteThreadState(
	thread: unknown,
	runs?: { completedAt: number | null; running: boolean }
): RemoteThreadState {
	const t = rec(thread);
	if (!t) return { title: null, pinned: null, settled: null, read: null };
	const title = threadTitle(t.title);
	const pinned = 'pinnedAt' in t ? t.pinnedAt !== null && t.pinnedAt !== undefined : null;
	let read: RemoteReadState | null = null;
	if ('lastVisitedAt' in t) {
		read = {
			visitedAt: time(t.lastVisitedAt) ?? 0,
			completedAt: runs ? runs.completedAt : time(t.latestRunCompletedAt),
			running: runs ? runs.running : typeof t.activeRunId === 'string' && t.activeRunId !== ''
		};
	}
	return { title, pinned, settled: threadSettled(t), read };
}

/**
 * Three-way merge of one value. `adopt`: T3 moved, apply its value here;
 * `agree`: both already match, record it; `push`: only Chatty moved.
 */
export function mergeValue<T>(
	local: T,
	agreed: T | null,
	remote: T
): 'adopt' | 'agree' | 'push' | null {
	if (agreed === null || agreed !== remote) return local === remote ? 'agree' : 'adopt';
	return local === remote ? null : 'push';
}

const flag = (v: number | null): boolean | null => (v === null ? null : v === 1);

/**
 * Compares a coding task's local state with its thread's and applies remote
 * changes locally. Returns true if a local change still has to be pushed.
 */
export function reconcileThreadState(
	db: Db,
	userId: string,
	conversationId: string,
	remote: RemoteThreadState
): boolean {
	const row = getCodingConversation(db, conversationId);
	let conversation = getConversation(db, userId, conversationId);
	if (!row?.thread_id || !conversation) return false;
	const patch: CodingConversationPatch = {};
	let push = false;
	let updated = false;

	if (remote.settled !== null) {
		const local = conversation.settled_at !== null;
		const merge = mergeValue(local, flag(row.remote_settled), remote.settled);
		if (merge === 'adopt') {
			if (remote.settled) {
				settleConversation(db, userId, conversationId, 'manual');
				onRunConversationSettled(db, userId, conversationId);
			} else {
				unsettleConversation(db, userId, conversationId);
				onRunConversationUnsettled(db, userId, conversationId);
			}
			publishServerEvent(userId, {
				type: 'conversation.settle_changed',
				conversationIds: [conversationId],
				settled: remote.settled
			});
			conversation = getConversation(db, userId, conversationId)!;
		}
		if (merge === 'adopt' || merge === 'agree') patch.remoteSettled = remote.settled;
		if (merge === 'push') push = true;
	}

	if (remote.pinned !== null) {
		const merge = mergeValue(conversation.pinned === 1, flag(row.remote_pinned), remote.pinned);
		if (merge === 'adopt') {
			setConversationPinned(db, userId, conversationId, remote.pinned);
			updated = true;
		}
		if (merge === 'adopt' || merge === 'agree') patch.remotePinned = remote.pinned;
		if (merge === 'push') push = true;
	}

	if (remote.title !== null) {
		// Compared capped like T3's value, so a long local title isn't "changed" by
		// T3 holding its first MAX_THREAD_TITLE_CHARS.
		const localTitle = threadTitle(conversation.title) ?? '';
		const merge = mergeValue(localTitle, row.remote_title, remote.title);
		if (merge === 'adopt') {
			updateConversation(db, userId, conversationId, { title: remote.title });
			updated = true;
		}
		if (merge === 'adopt' || merge === 'agree') patch.remoteTitle = remote.title;
		if (merge === 'push' && localTitle) push = true;
	}

	if (remote.read) {
		const { visitedAt, completedAt, running } = remote.read;
		const markedUnread = row.remote_visited_at !== null && visitedAt < row.remote_visited_at;
		if (row.remote_visited_at !== visitedAt) patch.remoteVisitedAt = visitedAt;
		const readAt = conversation.last_read_at ?? 0;
		const latest = latestAssistantMessageAt(db, conversationId);
		const localUnread = latest !== null && latest > readAt;
		if (completedAt !== null && completedAt > visitedAt) {
			// Unread on T3.
			if (!markedUnread && readAt > completedAt) push = true;
			else if (!localUnread && latest !== null) {
				setConversationReadAt(db, userId, conversationId, Math.min(readAt, latest - 1));
				updated = true;
			}
		} else if (localUnread && !running && visitedAt > readAt) {
			setConversationReadAt(db, userId, conversationId, visitedAt);
			updated = true;
		}
	}

	updateCodingConversation(db, conversationId, patch);
	if (updated) publishServerEvent(userId, { type: 'conversation.updated', conversationId });
	return push;
}

/** Commands that bring the thread in line with the local state, each with what it settles. */
function pendingCommands(
	row: CodingConversationRow,
	conversation: ConversationRow
): { command: Rec; agreed: CodingConversationPatch }[] {
	const threadId = row.thread_id!;
	const base = () => ({ commandId: randomUUID(), threadId });
	const commands: { command: Rec; agreed: CodingConversationPatch }[] = [];

	const settled = conversation.settled_at !== null;
	if (flag(row.remote_settled) !== settled) {
		commands.push({
			command: settled
				? { type: 'thread.settle', ...base() }
				: { type: 'thread.unsettle', ...base(), reason: 'user' },
			agreed: { remoteSettled: settled }
		});
	}

	const pinned = conversation.pinned === 1;
	const agreedPinned = flag(row.remote_pinned);
	if (agreedPinned === null ? pinned : agreedPinned !== pinned) {
		commands.push({
			command: { type: pinned ? 'thread.pin' : 'thread.unpin', ...base() },
			agreed: { remotePinned: pinned }
		});
	}

	// A title nobody compared yet is left to the first reconcile (T3's wins).
	// Sent and recorded capped, the same way T3's title is read back.
	const title = threadTitle(conversation.title);
	if (title && row.remote_title !== null && row.remote_title !== title) {
		commands.push({
			command: { type: 'thread.metadata.update', ...base(), title },
			agreed: { remoteTitle: title }
		});
	}

	// Visits only move T3's lastVisitedAt forward; the agreed value stays what
	// T3 last reported, so the next reconcile sees the visit land.
	const readAt = conversation.last_read_at ?? 0;
	if (readAt > (row.remote_visited_at ?? 0)) {
		commands.push({
			command: { type: 'thread.visit', ...base(), visitedAt: new Date(readAt).toISOString() },
			agreed: {}
		});
	}
	return commands;
}

async function pushOne(db: Db, conn: T3Connection, userId: string, id: string): Promise<void> {
	const row = getCodingConversation(db, id);
	const conversation = getConversation(db, userId, id);
	if (!row?.thread_id || !conversation) return;
	for (const { command, agreed } of pendingCommands(row, conversation)) {
		try {
			await conn.call('orchestration.dispatchCommand', command);
			updateCodingConversation(db, id, agreed);
		} catch (e) {
			// Typically a conflict with a concurrent change on T3 ("already
			// settled"); the next reconcile sorts it out either way.
			log.warn('Could not sync thread state to T3', {
				conversationId: id,
				command: command.type,
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}
}

const pushing = new Set<string>();
/** Pushes requested while one for the same task was in flight; re-run afterwards. */
const pushAgain = new Map<string, string>();

/**
 * Sends the local title, pinned, settled and read state of each coding
 * conversation to its T3 thread, where it differs from what T3 last agreed to
 * (tasks in sync need no connection). Non-coding ids are ignored; never throws.
 */
export async function pushThreadState(
	db: Db,
	userId: string,
	conversationIds: readonly string[]
): Promise<void> {
	const byEnv = new Map<string, string[]>();
	for (const id of conversationIds) {
		const row = getCodingConversation(db, id);
		if (!row?.thread_id || !row.environment_id) continue;
		const conversation = getConversation(db, userId, id);
		if (!conversation || pendingCommands(row, conversation).length === 0) continue;
		if (pushing.has(id)) {
			pushAgain.set(id, userId);
			continue;
		}
		byEnv.set(row.environment_id, [...(byEnv.get(row.environment_id) ?? []), id]);
	}
	await Promise.all(
		[...byEnv].map(async ([environmentId, ids]) => {
			const env = getCodingEnvironment(db, userId, environmentId);
			if (!env || env.enabled !== 1) return;
			for (const id of ids) pushing.add(id);
			try {
				await withT3Connection(env, async (conn) => {
					for (const id of ids) await pushOne(db, conn, userId, id);
				});
			} catch (e) {
				log.warn('Could not reach T3 to sync thread state', {
					environmentId,
					error: e instanceof Error ? e.message : String(e)
				});
			} finally {
				for (const id of ids) pushing.delete(id);
			}
		})
	);
	const again = conversationIds.filter((id) => pushAgain.get(id) === userId && !pushing.has(id));
	for (const id of again) pushAgain.delete(id);
	if (again.length > 0) await pushThreadState(db, userId, again);
}

/** Fire-and-forget {@link pushThreadState} for request handlers and jobs. */
export function queueThreadStatePush(
	db: Db,
	userId: string,
	conversationIds: readonly string[]
): void {
	void pushThreadState(db, userId, conversationIds);
}
