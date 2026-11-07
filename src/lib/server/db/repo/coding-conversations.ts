import type { Db } from '../index.js';
import type {
	CodingConversation,
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
		lastError: row.last_error
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
