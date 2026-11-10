import { randomUUID } from 'node:crypto';
import type { AgentCodingTarget } from '$lib/coding-environments.js';
import type { Agent, AgentCanAsk, AgentTriggerConfig, AgentTriggerType } from '$lib/types.js';
import type { Db } from '../index.js';

export interface AgentRow {
	id: string;
	user_id: string | null;
	name: string;
	description: string;
	system_prompt: string;
	provider_id: string | null;
	model_id: string | null;
	skill_names: string;
	tool_allowlist: string | null;
	trigger_type: string;
	trigger_config: string;
	max_steps: number | null;
	/** 'never' | 'approvals' | 'any': whether runs may ask the user (and so run as visible chats). */
	can_ask: string;
	/** JSON AgentCodingTarget; set for coding agents. */
	coding_target: string | null;
	enabled: number;
	last_run_at: number | null;
	next_run_at: number | null;
	created_at: number;
	updated_at: number;
}

export function toPublic(row: AgentRow): Agent {
	return {
		id: row.id,
		userId: row.user_id,
		name: row.name,
		description: row.description,
		systemPrompt: row.system_prompt,
		providerId: row.provider_id,
		modelId: row.model_id,
		skillNames: JSON.parse(row.skill_names) as string[],
		toolAllowlist: row.tool_allowlist ? (JSON.parse(row.tool_allowlist) as string[]) : null,
		triggerType: row.trigger_type as AgentTriggerType,
		triggerConfig: JSON.parse(row.trigger_config) as AgentTriggerConfig,
		maxSteps: row.max_steps,
		canAsk: parseCanAsk(row),
		codingTarget: parseCodingTarget(row),
		enabled: row.enabled === 1,
		lastRunAt: row.last_run_at,
		nextRunAt: row.next_run_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export function parseCanAsk(row: Pick<AgentRow, 'can_ask'>): AgentCanAsk {
	return row.can_ask === 'any' || row.can_ask === 'approvals' ? row.can_ask : 'never';
}

/** The agent's coding target, or null for a model agent. */
export function parseCodingTarget(row: Pick<AgentRow, 'coding_target'>): AgentCodingTarget | null {
	if (!row.coding_target) return null;
	try {
		return JSON.parse(row.coding_target) as AgentCodingTarget;
	} catch {
		return null;
	}
}

export interface CreateAgentInput {
	name: string;
	description?: string;
	systemPrompt: string;
	providerId?: string | null;
	modelId?: string | null;
	skillNames?: string[];
	toolAllowlist?: string[] | null;
	triggerType: AgentTriggerType;
	triggerConfig?: AgentTriggerConfig;
	maxSteps?: number | null;
	/** Defaults to 'any' for user agents and 'never' for built-ins. */
	canAsk?: AgentCanAsk;
	codingTarget?: AgentCodingTarget | null;
	enabled?: boolean;
	nextRunAt?: number | null;
}

export function createAgent(db: Db, userId: string | null, input: CreateAgentInput): AgentRow {
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		`INSERT INTO agents (id, user_id, name, description, system_prompt, provider_id, model_id,
		 skill_names, tool_allowlist, trigger_type, trigger_config, max_steps, can_ask, coding_target,
		 enabled, next_run_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		userId,
		input.name,
		input.description ?? '',
		input.systemPrompt,
		input.providerId ?? null,
		input.modelId ?? null,
		JSON.stringify(input.skillNames ?? []),
		input.toolAllowlist != null ? JSON.stringify(input.toolAllowlist) : null,
		input.triggerType,
		JSON.stringify(input.triggerConfig ?? {}),
		input.maxSteps ?? null,
		input.canAsk ?? (userId === null ? 'never' : 'any'),
		input.codingTarget ? JSON.stringify(input.codingTarget) : null,
		input.enabled === false ? 0 : 1,
		input.nextRunAt ?? null,
		now,
		now
	);
	return getAgent(db, id)!;
}

export function getAgent(db: Db, id: string): AgentRow | undefined {
	return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
}

export function listAgents(db: Db, userId: string): AgentRow[] {
	return db
		.prepare(
			`SELECT * FROM agents
			 WHERE user_id = ? OR user_id IS NULL
			 ORDER BY user_id IS NULL, name`
		)
		.all(userId) as AgentRow[];
}

export function listPersonaAgents(db: Db, userId: string): AgentRow[] {
	return db
		.prepare(
			`SELECT * FROM agents
			 WHERE (user_id = ? OR user_id IS NULL) AND trigger_type = 'persona' AND enabled = 1
			 ORDER BY user_id IS NULL, name`
		)
		.all(userId) as AgentRow[];
}

export function listDueScheduleAgents(db: Db, now: number): AgentRow[] {
	return db
		.prepare(
			`SELECT * FROM agents
			 WHERE trigger_type = 'schedule' AND (enabled = 1 OR user_id IS NULL)
			   AND next_run_at IS NOT NULL AND next_run_at <= ?
			   AND NOT EXISTS (
			       SELECT 1 FROM agent_runs
			       WHERE agent_runs.agent_id = agents.id AND agent_runs.status = 'running'
			   )`
		)
		.all(now) as AgentRow[];
}

export function listEventAgents(db: Db, event: string): AgentRow[] {
	return db
		.prepare(
			`SELECT * FROM agents
			 WHERE trigger_type = 'event' AND (enabled = 1 OR user_id IS NULL)
			   AND json_extract(trigger_config, '$.event') = ?`
		)
		.all(event) as AgentRow[];
}

export function incrementAgentEventCounter(
	db: Db,
	agentId: string,
	userId: string,
	event: string
): number {
	db.prepare(
		`INSERT INTO agent_event_counters (agent_id, user_id, event, count)
		 VALUES (?, ?, ?, 1)
		 ON CONFLICT(agent_id, user_id, event)
		 DO UPDATE SET count = count + 1`
	).run(agentId, userId, event);
	const row = db
		.prepare(
			'SELECT count FROM agent_event_counters WHERE agent_id = ? AND user_id = ? AND event = ?'
		)
		.get(agentId, userId, event) as { count: number };
	return row.count;
}

export function setAgentOverride(db: Db, userId: string, agentId: string, enabled: boolean): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO agent_user_overrides (user_id, agent_id, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, agent_id)
		 DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
	).run(userId, agentId, enabled ? 1 : 0, now, now);
}

export function listAgentOverrides(db: Db, userId: string): Map<string, boolean> {
	const rows = db
		.prepare('SELECT agent_id, enabled FROM agent_user_overrides WHERE user_id = ?')
		.all(userId) as { agent_id: string; enabled: number }[];
	return new Map(rows.map((row) => [row.agent_id, row.enabled === 1]));
}

export function listOverridesForAgent(db: Db, agentId: string): Map<string, boolean> {
	const rows = db
		.prepare('SELECT user_id, enabled FROM agent_user_overrides WHERE agent_id = ?')
		.all(agentId) as { user_id: string; enabled: number }[];
	return new Map(rows.map((row) => [row.user_id, row.enabled === 1]));
}

export function effectiveEnabled(agent: AgentRow, overrides: Map<string, boolean>): boolean {
	if (agent.user_id === null) return overrides.get(agent.id) ?? agent.enabled === 1;
	return agent.enabled === 1;
}

export function toPublicWithOverrides(row: AgentRow, overrides: Map<string, boolean>): Agent {
	return { ...toPublic(row), enabled: effectiveEnabled(row, overrides) };
}

/**
 * Users with conversation activity a built-in (per-user) agent hasn't seen:
 * conversations updated after that user's latest finished run of the agent.
 * Tracked per user, not via the agent's single `last_run_at`, which any one
 * user's run (scheduled or manual) moves for everyone. The agent's own run
 * transcripts don't count as activity, and neither do chats Chatty dispatched
 * for any agent's runs (agent output, not user activity; counting an agent's own
 * visible runs would re-trigger it after every run).
 */
export function listUsersWithActivitySinceLastRun(db: Db, agentId: string): string[] {
	return (
		db
			.prepare(
				`SELECT DISTINCT c.user_id FROM conversations c
				 WHERE c.deleted_at IS NULL
				   AND NOT (c.kind = 'agent-run' AND c.agent_id IS ?)
				   AND c.origin != 'dispatch'
				   AND c.updated_at > COALESCE(
				       (SELECT MAX(r.ended_at) FROM agent_runs r
				        WHERE r.agent_id = ? AND r.user_id = c.user_id), 0)
				 ORDER BY c.user_id`
			)
			.all(agentId, agentId) as { user_id: string }[]
	).map((row) => row.user_id);
}

export interface UpdateAgentInput {
	name?: string;
	description?: string;
	systemPrompt?: string;
	providerId?: string | null;
	modelId?: string | null;
	skillNames?: string[];
	toolAllowlist?: string[] | null;
	triggerType?: AgentTriggerType;
	triggerConfig?: AgentTriggerConfig;
	maxSteps?: number | null;
	canAsk?: AgentCanAsk;
	codingTarget?: AgentCodingTarget | null;
	enabled?: boolean;
	nextRunAt?: number | null;
	lastRunAt?: number | null;
}

export function updateAgent(db: Db, id: string, patch: UpdateAgentInput): AgentRow | undefined {
	const existing = getAgent(db, id);
	if (!existing) return undefined;
	db.prepare(
		`UPDATE agents SET name = ?, description = ?, system_prompt = ?, provider_id = ?, model_id = ?,
		 skill_names = ?, tool_allowlist = ?, trigger_type = ?, trigger_config = ?, max_steps = ?,
		 can_ask = ?, coding_target = ?, enabled = ?, next_run_at = ?, last_run_at = ?, updated_at = ?
		 WHERE id = ?`
	).run(
		patch.name ?? existing.name,
		patch.description ?? existing.description,
		patch.systemPrompt ?? existing.system_prompt,
		patch.providerId !== undefined ? patch.providerId : existing.provider_id,
		patch.modelId !== undefined ? patch.modelId : existing.model_id,
		patch.skillNames !== undefined ? JSON.stringify(patch.skillNames) : existing.skill_names,
		patch.toolAllowlist !== undefined
			? patch.toolAllowlist != null
				? JSON.stringify(patch.toolAllowlist)
				: null
			: existing.tool_allowlist,
		patch.triggerType ?? existing.trigger_type,
		patch.triggerConfig !== undefined
			? JSON.stringify(patch.triggerConfig)
			: existing.trigger_config,
		patch.maxSteps !== undefined ? patch.maxSteps : existing.max_steps,
		patch.canAsk ?? existing.can_ask,
		patch.codingTarget !== undefined
			? patch.codingTarget
				? JSON.stringify(patch.codingTarget)
				: null
			: existing.coding_target,
		patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
		patch.nextRunAt !== undefined ? patch.nextRunAt : existing.next_run_at,
		patch.lastRunAt !== undefined ? patch.lastRunAt : existing.last_run_at,
		Date.now(),
		id
	);
	return getAgent(db, id);
}

export function deleteAgent(db: Db, id: string): boolean {
	return db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0;
}

export function setAgentRunTimes(
	db: Db,
	id: string,
	times: { lastRunAt?: number | null; nextRunAt?: number | null }
): void {
	const existing = getAgent(db, id);
	if (!existing) return;
	db.prepare('UPDATE agents SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(
		times.lastRunAt !== undefined ? times.lastRunAt : existing.last_run_at,
		times.nextRunAt !== undefined ? times.nextRunAt : existing.next_run_at,
		id
	);
}

export function claimAgentRun(
	db: Db,
	id: string,
	expectedNextRunAt: number | null,
	newNextRunAt: number | null
): boolean {
	return (
		db
			.prepare('UPDATE agents SET next_run_at = ? WHERE id = ? AND next_run_at IS ?')
			.run(newNextRunAt, id, expectedNextRunAt).changes === 1
	);
}
