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
	status: 'success' | 'failed',
	error?: string | null
): void {
	db.prepare('UPDATE agent_runs SET status = ?, error = ?, ended_at = ? WHERE id = ?').run(
		status,
		error ?? null,
		Date.now(),
		id
	);
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

export function failRunningAgentRuns(db: Db): number {
	return db
		.prepare(
			`UPDATE agent_runs SET status = 'failed', error = 'Interrupted by server restart', ended_at = ?
			 WHERE status = 'running'`
		)
		.run(Date.now()).changes;
}
