import { randomUUID } from 'node:crypto';
import type { AgentRun, AgentRunStatus, AgentRunTrigger } from '$lib/types.js';
import type { Db } from '../index.js';

export interface AgentRunRow {
	id: string;
	agent_id: string;
	user_id: string;
	trigger: string;
	conversation_id: string | null;
	status: string;
	error: string | null;
	started_at: number;
	ended_at: number | null;
}

export function toPublic(row: AgentRunRow): AgentRun {
	return {
		id: row.id,
		agentId: row.agent_id,
		userId: row.user_id,
		trigger: row.trigger as AgentRunTrigger,
		status: row.status as AgentRunStatus,
		conversationId: row.conversation_id,
		error: row.error,
		startedAt: row.started_at,
		endedAt: row.ended_at
	};
}

export interface CreateAgentRunInput {
	id?: string;
	agentId: string;
	userId: string;
	trigger: AgentRunTrigger;
	conversationId?: string | null;
}

export function createAgentRun(db: Db, input: CreateAgentRunInput): AgentRunRow {
	const id = input.id ?? randomUUID();
	db.prepare(
		`INSERT INTO agent_runs (id, agent_id, user_id, trigger, conversation_id, status, started_at)
		 VALUES (?, ?, ?, ?, ?, 'running', ?)`
	).run(id, input.agentId, input.userId, input.trigger, input.conversationId ?? null, Date.now());
	return getAgentRun(db, id)!;
}

export function finishAgentRun(
	db: Db,
	id: string,
	status: 'success' | 'failed' | 'awaiting_input' | 'dismissed',
	error?: string | null
): void {
	db.prepare('UPDATE agent_runs SET status = ?, error = ?, ended_at = ? WHERE id = ?').run(
		status,
		error ?? null,
		Date.now(),
		id
	);
}

/**
 * Moves a run that waits for the user's answer back to `running` (the user
 * replied). False when it no longer waits, e.g. it was dismissed meanwhile.
 */
export function resumeAgentRun(db: Db, id: string): boolean {
	return (
		db
			.prepare(
				`UPDATE agent_runs SET status = 'running', error = NULL, ended_at = NULL
				 WHERE id = ? AND status = 'awaiting_input'`
			)
			.run(id).changes === 1
	);
}

/**
 * Marks a run whose question was left unanswered as `dismissed`. Only a run
 * still `awaiting_input` changes; returns whether it did.
 */
export function dismissAgentRun(db: Db, id: string, reason: string): boolean {
	return (
		db
			.prepare(
				`UPDATE agent_runs SET status = 'dismissed', error = ?, ended_at = ?
				 WHERE id = ? AND status = 'awaiting_input'`
			)
			.run(reason, Date.now(), id).changes === 1
	);
}

/**
 * Puts a dismissed run back to waiting for the user's answer (its chat was
 * brought back). Only a `dismissed` run changes; returns whether it did.
 */
export function reopenAgentRun(db: Db, id: string): boolean {
	return (
		db
			.prepare(
				`UPDATE agent_runs SET status = 'awaiting_input', error = NULL, ended_at = ?
				 WHERE id = ? AND status = 'dismissed'`
			)
			.run(Date.now(), id).changes === 1
	);
}

/** The run of `conversationId` that waits for the user's answer, if any. */
export function getAwaitingAgentRunByConversation(
	db: Db,
	conversationId: string
): AgentRunRow | undefined {
	return db
		.prepare(
			`SELECT * FROM agent_runs WHERE conversation_id = ? AND status = 'awaiting_input'
			 ORDER BY started_at DESC LIMIT 1`
		)
		.get(conversationId) as AgentRunRow | undefined;
}

/**
 * Whether the agent already has a question open for this user (other than in
 * run `exceptRunId`): agents ask at most one question at a time.
 */
export function hasOpenAgentQuestion(
	db: Db,
	agentId: string,
	userId: string,
	exceptRunId?: string
): boolean {
	return (
		db
			.prepare(
				`SELECT 1 FROM agent_runs
				 WHERE agent_id = ? AND user_id = ? AND status = 'awaiting_input' AND id IS NOT ?
				 LIMIT 1`
			)
			.get(agentId, userId, exceptRunId ?? null) !== undefined
	);
}

/** Runs that have waited for an answer since before `cutoffMs`. */
export function listAwaitingAgentRunsBefore(db: Db, cutoffMs: number): AgentRunRow[] {
	return db
		.prepare(
			`SELECT * FROM agent_runs WHERE status = 'awaiting_input' AND COALESCE(ended_at, started_at) < ?`
		)
		.all(cutoffMs) as AgentRunRow[];
}

/** Conversations whose latest run waits for the user's answer (kept out of auto-settle). */
export function listAwaitingAgentRunConversationIds(db: Db): string[] {
	return (
		db
			.prepare(
				`SELECT DISTINCT conversation_id FROM agent_runs
				 WHERE status = 'awaiting_input' AND conversation_id IS NOT NULL`
			)
			.all() as { conversation_id: string }[]
	).map((r) => r.conversation_id);
}

export function setAgentRunConversation(db: Db, id: string, conversationId: string): void {
	db.prepare('UPDATE agent_runs SET conversation_id = ? WHERE id = ?').run(conversationId, id);
}

/** The user's newest still-running run of the agent, if any. */
export function getRunningAgentRun(
	db: Db,
	agentId: string,
	userId: string
): AgentRunRow | undefined {
	return db
		.prepare(
			"SELECT * FROM agent_runs WHERE agent_id = ? AND user_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1"
		)
		.get(agentId, userId) as AgentRunRow | undefined;
}

export function hasRunningAgentRun(db: Db, agentId: string, userId: string): boolean {
	return (
		db
			.prepare(
				"SELECT 1 FROM agent_runs WHERE agent_id = ? AND user_id = ? AND status = 'running' LIMIT 1"
			)
			.get(agentId, userId) !== undefined
	);
}

/**
 * Start time of the agent's latest successful run for this user. The start (not
 * the end) is used so activity that happened while that run was going is still
 * covered by the next one.
 */
export function lastSuccessfulAgentRunStartedAt(
	db: Db,
	agentId: string,
	userId: string
): number | null {
	const row = db
		.prepare(
			"SELECT MAX(started_at) AS at FROM agent_runs WHERE agent_id = ? AND user_id = ? AND status = 'success'"
		)
		.get(agentId, userId) as { at: number | null };
	return row.at;
}

export function getAgentRun(db: Db, id: string): AgentRunRow | undefined {
	return db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRunRow | undefined;
}

export function getAgentRunByConversation(db: Db, conversationId: string): AgentRunRow | undefined {
	return db
		.prepare('SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1')
		.get(conversationId) as AgentRunRow | undefined;
}

export function listAgentRuns(db: Db, agentId: string, limit = 50, userId?: string): AgentRunRow[] {
	if (userId !== undefined) {
		return db
			.prepare(
				'SELECT * FROM agent_runs WHERE agent_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT ?'
			)
			.all(agentId, userId, limit) as AgentRunRow[];
	}
	return db
		.prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?')
		.all(agentId, limit) as AgentRunRow[];
}

export function listRunningAgentIds(db: Db, agentIds: string[]): string[] {
	if (agentIds.length === 0) return [];
	const placeholders = agentIds.map(() => '?').join(', ');
	return (
		db
			.prepare(
				`SELECT DISTINCT agent_id FROM agent_runs
				 WHERE status = 'running' AND agent_id IN (${placeholders})`
			)
			.all(...agentIds) as { agent_id: string }[]
	).map((r) => r.agent_id);
}

/** Each agent's most recent run for `userId` (agents without runs are left out). */
export function listLatestAgentRuns(db: Db, agentIds: string[], userId: string): AgentRunRow[] {
	if (agentIds.length === 0) return [];
	const placeholders = agentIds.map(() => '?').join(', ');
	return db
		.prepare(
			`SELECT * FROM (
				SELECT *, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY started_at DESC, rowid DESC) AS rn
				FROM agent_runs WHERE user_id = ? AND agent_id IN (${placeholders})
			) WHERE rn = 1`
		)
		.all(userId, ...agentIds) as AgentRunRow[];
}

/** The run still waiting on its coding task in `conversationId`, if any. */
export function getRunningAgentRunByConversation(
	db: Db,
	conversationId: string
): AgentRunRow | undefined {
	return db
		.prepare(
			`SELECT * FROM agent_runs WHERE conversation_id = ? AND status = 'running'
			 ORDER BY started_at DESC LIMIT 1`
		)
		.get(conversationId) as AgentRunRow | undefined;
}

/** Whether `conversationId` was created by an agent run (of any agent). */
export function isAgentRunConversation(db: Db, conversationId: string): boolean {
	return !!db
		.prepare('SELECT 1 FROM agent_runs WHERE conversation_id = ? LIMIT 1')
		.get(conversationId);
}

/**
 * Fails runs left `running` by a restart. Coding agent runs whose T3 task is
 * still live are kept: the remote agent kept working, and the follower that
 * resumes on startup settles the run when the task ends.
 */
export function failRunningAgentRuns(db: Db): number {
	return db
		.prepare(
			`UPDATE agent_runs SET status = 'failed', error = 'Interrupted by server restart', ended_at = ?
			 WHERE status = 'running'
			   AND NOT EXISTS (
			       SELECT 1 FROM coding_conversations cc
			       JOIN conversations c ON c.id = cc.conversation_id
			       WHERE cc.conversation_id = agent_runs.conversation_id
			         AND c.deleted_at IS NULL AND cc.thread_id IS NOT NULL
			         AND cc.status IN ('starting', 'running', 'awaiting_input')
			   )`
		)
		.run(Date.now()).changes;
}
