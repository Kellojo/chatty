import type { Db } from '../index.js';
import { createConversation } from './conversations.js';
import type {
	CodingConversation,
	CodingDiffStat,
	CodingPendingRequest,
	CodingTaskStatus,
	CodingWorkspaceMode
} from '$lib/coding-environments.js';

export interface CodingConversationRow {
	conversation_id: string;
	environment_id: string | null;
	project_id: string;
	project_title: string;
	thread_id: string | null;
	provider_instance_id: string;
	model: string;
	runtime_mode: string;
	workspace_mode: CodingWorkspaceMode;
	base_branch: string | null;
	branch: string | null;
	pr_url: string | null;
	status: CodingTaskStatus;
	pending_request: string | null;
	last_sequence: number | null;
	last_error: string | null;
	/** Settled state last agreed with the T3 thread (0/1), NULL if never compared. */
	remote_settled: number | null;
	/** Title last agreed with the T3 thread, NULL if never compared. */
	remote_title: string | null;
	/** Pinned state last agreed with the T3 thread (0/1), NULL if never compared. */
	remote_pinned: number | null;
	/** The thread's `lastVisitedAt` (ms, 0 = never) when last seen, NULL if never seen. */
	remote_visited_at: number | null;
	run_started_at: number | null;
	diff_insertions: number | null;
	diff_deletions: number | null;
	created_at: number;
	updated_at: number;
}

function parsePending(raw: string | null): CodingPendingRequest | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as CodingPendingRequest;
	} catch {
		return null;
	}
}

export function toPublic(row: CodingConversationRow): CodingConversation {
	return {
		conversationId: row.conversation_id,
		environmentId: row.environment_id,
		projectId: row.project_id,
		projectTitle: row.project_title,
		threadId: row.thread_id,
		providerInstanceId: row.provider_instance_id,
		model: row.model,
		runtimeMode: row.runtime_mode,
		workspaceMode: row.workspace_mode,
		baseBranch: row.base_branch,
		branch: row.branch,
		prUrl: row.pr_url,
		status: row.status,
		pendingRequest: parsePending(row.pending_request),
		lastError: row.last_error,
		runStartedAt: row.run_started_at,
		diff:
			row.diff_insertions === null || row.diff_deletions === null
				? null
				: { insertions: row.diff_insertions, deletions: row.diff_deletions }
	};
}

export function getCodingConversation(
	db: Db,
	conversationId: string
): CodingConversationRow | undefined {
	return db
		.prepare('SELECT * FROM coding_conversations WHERE conversation_id = ?')
		.get(conversationId) as CodingConversationRow | undefined;
}

/** Scoped lookup: only returns the row if the conversation belongs to `userId`. */
export function getCodingConversationForUser(
	db: Db,
	userId: string,
	conversationId: string
): CodingConversationRow | undefined {
	return db
		.prepare(
			`SELECT cc.* FROM coding_conversations cc
			 JOIN conversations c ON c.id = cc.conversation_id
			 WHERE cc.conversation_id = ? AND c.user_id = ? AND c.deleted_at IS NULL`
		)
		.get(conversationId, userId) as CodingConversationRow | undefined;
}

export interface CreateCodingConversationInput {
	conversationId: string;
	environmentId: string;
	projectId: string;
	projectTitle: string;
	providerInstanceId: string;
	model: string;
	runtimeMode: string;
	workspaceMode: CodingWorkspaceMode;
	baseBranch: string | null;
}

export function createCodingConversation(
	db: Db,
	input: CreateCodingConversationInput
): CodingConversationRow {
	const now = Date.now();
	db.prepare(
		`INSERT INTO coding_conversations (conversation_id, environment_id, project_id, project_title,
		   provider_instance_id, model, runtime_mode, workspace_mode, base_branch, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)`
	).run(
		input.conversationId,
		input.environmentId,
		input.projectId,
		input.projectTitle,
		input.providerInstanceId,
		input.model,
		input.runtimeMode,
		input.workspaceMode,
		input.baseBranch,
		now,
		now
	);
	return getCodingConversation(db, input.conversationId)!;
}

export interface CodingConversationPatch {
	threadId?: string;
	status?: CodingTaskStatus;
	branch?: string | null;
	prUrl?: string | null;
	pendingRequest?: CodingPendingRequest | null;
	lastSequence?: number;
	lastError?: string | null;
	remoteSettled?: boolean;
	remoteTitle?: string;
	remotePinned?: boolean;
	remoteVisitedAt?: number;
	runStartedAt?: number | null;
	diff?: CodingDiffStat;
}

export function updateCodingConversation(
	db: Db,
	conversationId: string,
	patch: CodingConversationPatch
): CodingConversationRow | undefined {
	const sets: string[] = [];
	const values: unknown[] = [];
	const set = (column: string, value: unknown) => {
		sets.push(`${column} = ?`);
		values.push(value);
	};
	if (patch.threadId !== undefined) set('thread_id', patch.threadId);
	if (patch.status !== undefined) set('status', patch.status);
	if (patch.branch !== undefined) set('branch', patch.branch);
	if (patch.prUrl !== undefined) set('pr_url', patch.prUrl);
	if (patch.pendingRequest !== undefined) {
		set('pending_request', patch.pendingRequest ? JSON.stringify(patch.pendingRequest) : null);
	}
	if (patch.lastSequence !== undefined) set('last_sequence', patch.lastSequence);
	if (patch.lastError !== undefined) set('last_error', patch.lastError);
	if (patch.remoteSettled !== undefined) set('remote_settled', patch.remoteSettled ? 1 : 0);
	if (patch.remoteTitle !== undefined) set('remote_title', patch.remoteTitle);
	if (patch.remotePinned !== undefined) set('remote_pinned', patch.remotePinned ? 1 : 0);
	if (patch.remoteVisitedAt !== undefined) set('remote_visited_at', patch.remoteVisitedAt);
	if (patch.runStartedAt !== undefined) set('run_started_at', patch.runStartedAt);
	if (patch.diff !== undefined) {
		set('diff_insertions', patch.diff.insertions);
		set('diff_deletions', patch.diff.deletions);
	}
	if (sets.length > 0) {
		set('updated_at', Date.now());
		db.prepare(`UPDATE coding_conversations SET ${sets.join(', ')} WHERE conversation_id = ?`).run(
			...values,
			conversationId
		);
	}
	return getCodingConversation(db, conversationId);
}

/** Tasks that may still produce output and should be followed after a restart. */
export function listLiveCodingConversations(
	db: Db
): (CodingConversationRow & { user_id: string })[] {
	return db
		.prepare(
			`SELECT cc.*, c.user_id AS user_id FROM coding_conversations cc
			 JOIN conversations c ON c.id = cc.conversation_id
			 WHERE c.deleted_at IS NULL AND cc.thread_id IS NOT NULL
			   AND cc.status IN ('starting', 'running', 'awaiting_input')`
		)
		.all() as (CodingConversationRow & { user_id: string })[];
}

/** Tasks on `environmentId` that have a remote thread (their metadata is synced). */
export function listThreadCodingConversations(
	db: Db,
	environmentId: string
): (CodingConversationRow & { user_id: string })[] {
	return db
		.prepare(
			`SELECT cc.*, c.user_id AS user_id FROM coding_conversations cc
			 JOIN conversations c ON c.id = cc.conversation_id
			 WHERE c.deleted_at IS NULL AND cc.thread_id IS NOT NULL AND cc.environment_id = ?`
		)
		.all(environmentId) as (CodingConversationRow & { user_id: string })[];
}

/**
 * Thread ids the owner of `environmentId` already has: linked to one of their
 * conversations (even a deleted one, or one on another of their environments,
 * e.g. the same T3 server added twice) or dismissed on this environment after
 * its conversation was purged.
 */
export function listKnownThreadIds(db: Db, environmentId: string): Set<string> {
	const rows = db
		.prepare(
			`SELECT cc.thread_id FROM coding_conversations cc
			 JOIN conversations c ON c.id = cc.conversation_id
			 WHERE cc.thread_id IS NOT NULL
			   AND c.user_id = (SELECT user_id FROM coding_environments WHERE id = ?)
			 UNION SELECT thread_id FROM coding_dismissed_threads WHERE environment_id = ?`
		)
		.all(environmentId, environmentId) as { thread_id: string }[];
	return new Set(rows.map((r) => r.thread_id));
}

/**
 * Links the owner's coding conversations whose environment was removed back to
 * `environmentId` when it serves their thread (the environment was added
 * again), instead of importing the thread once more. Returns their ids.
 */
export function relinkOrphanedThreads(
	db: Db,
	environmentId: string,
	threadIds: ReadonlySet<string>
): string[] {
	const orphans = db
		.prepare(
			`SELECT cc.conversation_id, cc.thread_id FROM coding_conversations cc
			 JOIN conversations c ON c.id = cc.conversation_id
			 WHERE cc.environment_id IS NULL AND cc.thread_id IS NOT NULL
			   AND c.user_id = (SELECT user_id FROM coding_environments WHERE id = ?)`
		)
		.all(environmentId) as { conversation_id: string; thread_id: string }[];
	const relinked = orphans.filter((o) => threadIds.has(o.thread_id)).map((o) => o.conversation_id);
	const update = db.prepare(
		'UPDATE coding_conversations SET environment_id = ?, updated_at = ? WHERE conversation_id = ?'
	);
	const now = Date.now();
	db.transaction(() => {
		for (const id of relinked) update.run(environmentId, now, id);
	})();
	return relinked;
}

export interface ImportCodingConversationInput extends Omit<
	CreateCodingConversationInput,
	'conversationId'
> {
	userId: string;
	threadId: string;
	title: string;
	status: CodingTaskStatus;
	branch: string | null;
	settled: boolean;
	pinned: boolean;
	/** The thread's `lastVisitedAt` (ms, 0 = never visited). */
	visitedAt: number;
	createdAt: number;
	updatedAt: number;
}

/**
 * Creates the conversation + task record for a thread that was started on the
 * T3 server itself. It starts out read as far as T3 has seen it (the thread
 * state sync takes it from there); the follower fills in the history.
 */
export function importCodingConversation(db: Db, input: ImportCodingConversationInput): string {
	return db.transaction(() => {
		const conversation = createConversation(db, input.userId, {
			kind: 'chat',
			mode: 'agent',
			title: input.title
		});
		db.prepare(
			`UPDATE conversations
			 SET created_at = ?, updated_at = ?, last_read_at = ?, settled_at = ?, settled_reason = ?,
			     pinned = ?
			 WHERE id = ?`
		).run(
			input.createdAt,
			input.updatedAt,
			input.visitedAt,
			input.settled ? input.updatedAt : null,
			input.settled ? 'manual' : null,
			input.pinned ? 1 : 0,
			conversation.id
		);
		createCodingConversation(db, { ...input, conversationId: conversation.id });
		updateCodingConversation(db, conversation.id, {
			threadId: input.threadId,
			status: input.status,
			branch: input.branch,
			remoteSettled: input.settled,
			remoteTitle: input.title,
			remotePinned: input.pinned,
			remoteVisitedAt: input.visitedAt
		});
		return conversation.id;
	})();
}

/** Number of not-deleted coding conversations on `environmentId` that have a remote thread. */
export function countThreadCodingConversations(db: Db, environmentId: string): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM coding_conversations cc
			 JOIN conversations c ON c.id = cc.conversation_id
			 WHERE c.deleted_at IS NULL AND cc.thread_id IS NOT NULL AND cc.environment_id = ?`
		)
		.get(environmentId) as { n: number };
	return row.n;
}
