import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	agentCreateSchema,
	agentPatchSchema,
	prepareAgentCreate,
	prepareAgentUpdate
} from '../../agentInput.js';
import { runsAsChats } from '../../agents/run-lifecycle.js';
import { describeRunResult, RUN_WAIT_MAX_MS, waitForRunToSettle } from '../../agents/run-result.js';
import { startAgentRun } from '../../agents/runner.js';
import { getDb, type Db } from '../../db/index.js';
import { getAgentRun, getRunningAgentRun, type AgentRunRow } from '../../db/repo/agent-runs.js';
import {
	createAgent,
	deleteAgent,
	getAgent,
	listAgentOverrides,
	listAgents,
	toPublic,
	toPublicWithOverrides,
	updateAgent,
	type AgentRow
} from '../../db/repo/agents.js';
import { findModel } from '../../db/repo/models.js';
import { createLogger } from '../../logger.js';
import { MAX_LAUNCH_PROMPT } from '../../t3/tasks.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const log = createLogger('mcp:agents');

const MODEL_FIELD_DESCRIPTIONS = {
	providerId: 'Provider id (must be given together with modelId)',
	modelId: 'Model id (must be given together with providerId)'
};

/** Card instructions, given once (create_agent); get/update_agent point at them. */
const CARD_HINT =
	'To show the agent as a card, reply with a ```agent fenced block of the result JSON (systemPrompt may be omitted).';
const SAME_CARD = 'Returns the same JSON as create_agent (```agent card).';

/** A run as start_agent / get_agent_run return it (the chat's agent run row reads this). */
function runResult(db: Db, run: AgentRunRow, agent: AgentRow) {
	return text(
		JSON.stringify(
			describeRunResult(
				db,
				run,
				{ id: agent.id, name: agent.name },
				{ visible: runsAsChats(agent) }
			)
		)
	);
}

/** The public agent plus its model's display name, which the ```agent card shows. */
function agentResult(db: Db, row: AgentRow) {
	const agent = toPublic(row);
	const model =
		agent.providerId && agent.modelId ? findModel(db, agent.providerId, agent.modelId) : undefined;
	return text(JSON.stringify({ ...agent, modelName: model?.display_name ?? null }));
}

export function createAgentsServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-agents', version: '0.1.0' });

	server.registerTool(
		'list_agents',
		{
			description:
				"List the current user's agents (including built-in agents), with their triggers and status"
		},
		async () => {
			const db = getDb();
			const rows = listAgents(db, ctx.userId);
			// Built-in agents can be switched off per user; report what the user sees.
			const overrides = listAgentOverrides(db, ctx.userId);
			log.info('list_agents', { userId: ctx.userId, count: rows.length });
			return text(
				JSON.stringify(
					rows.map((r) => {
						const pub = toPublicWithOverrides(r, overrides);
						return {
							id: pub.id,
							name: pub.name,
							description: pub.description,
							triggerType: pub.triggerType,
							triggerConfig: pub.triggerConfig,
							enabled: pub.enabled,
							builtin: r.user_id === null,
							coding: r.coding_target !== null,
							lastRunAt: pub.lastRunAt,
							nextRunAt: pub.nextRunAt
						};
					})
				)
			);
		}
	);

	server.registerTool(
		'get_agent',
		{
			description: `Get the full configuration of one agent by id. ${SAME_CARD}`,
			inputSchema: { agentId: z.string() }
		},
		async ({ agentId }) => {
			const db = getDb();
			const agent = getAgent(db, agentId);
			if (!agent || (agent.user_id !== ctx.userId && agent.user_id !== null)) {
				log.warn('get_agent not found', { userId: ctx.userId, agentId });
				return err('agent not found');
			}
			log.info('get_agent', { userId: ctx.userId, agentId });
			return agentResult(db, agent);
		}
	);

	server.registerTool(
		'create_agent',
		{
			description:
				'Create a new agent for the current user. triggerType persona makes it selectable in chat; schedule requires a cron expression; event requires an event name. ' +
				CARD_HINT,
			inputSchema: {
				...agentCreateSchema.shape,
				providerId: agentCreateSchema.shape.providerId.describe(
					MODEL_FIELD_DESCRIPTIONS.providerId
				),
				modelId: agentCreateSchema.shape.modelId.describe(MODEL_FIELD_DESCRIPTIONS.modelId)
			}
		},
		async (input) => {
			const db = getDb();
			const prepared = prepareAgentCreate(db, input);
			if (!prepared.ok) return err(prepared.error);
			const agent = createAgent(db, ctx.userId, prepared.value);
			log.info('create_agent', {
				userId: ctx.userId,
				agentId: agent.id,
				name: input.name,
				triggerType: input.triggerType
			});
			return agentResult(db, agent);
		}
	);

	server.registerTool(
		'update_agent',
		{
			description: `Update an agent owned by the current user; only given fields change. ${SAME_CARD}`,
			inputSchema: {
				agentId: z.string(),
				...agentPatchSchema.shape,
				providerId: agentPatchSchema.shape.providerId.describe(MODEL_FIELD_DESCRIPTIONS.providerId),
				modelId: agentPatchSchema.shape.modelId.describe(MODEL_FIELD_DESCRIPTIONS.modelId),
				triggerConfig: agentPatchSchema.shape.triggerConfig.describe(
					'Fields given here are merged into the existing trigger config'
				)
			}
		},
		async ({ agentId, ...patch }) => {
			const db = getDb();
			const existing = getAgent(db, agentId);
			if (!existing || (existing.user_id !== ctx.userId && existing.user_id !== null)) {
				log.warn('update_agent not found', { userId: ctx.userId, agentId });
				return err('agent not found');
			}
			if (existing.user_id === null) {
				log.warn('update_agent builtin attempt', { userId: ctx.userId, agentId });
				return err('built-in agents cannot be modified');
			}
			// Their prompt becomes work done in the user's repositories, so only
			// the user changes it (on the Agents page), never a chat model.
			if (existing.coding_target) {
				log.warn('update_agent coding agent attempt', { userId: ctx.userId, agentId });
				return err('coding agents can only be changed by the user on the Agents page');
			}
			const prepared = prepareAgentUpdate(db, existing, patch, { mergeTriggerConfig: true });
			if (!prepared.ok) return err(prepared.error);
			const updated = updateAgent(db, agentId, prepared.value);
			log.info('update_agent', { userId: ctx.userId, agentId, fields: Object.keys(patch) });
			return agentResult(db, updated!);
		}
	);

	server.registerTool(
		'delete_agent',
		{
			description: 'Delete an agent owned by the current user. Built-in agents cannot be deleted.',
			inputSchema: { agentId: z.string() }
		},
		async ({ agentId }) => {
			const db = getDb();
			const existing = getAgent(db, agentId);
			if (!existing || (existing.user_id !== ctx.userId && existing.user_id !== null)) {
				log.warn('delete_agent not found', { userId: ctx.userId, agentId });
				return err('agent not found');
			}
			if (existing.user_id === null) {
				log.warn('delete_agent builtin attempt', { userId: ctx.userId, agentId });
				return err('built-in agents cannot be deleted');
			}
			deleteAgent(db, agentId);
			log.info('delete_agent', { userId: ctx.userId, agentId });
			return text(`deleted agent ${agentId}`);
		}
	);

	server.registerTool(
		'start_agent',
		{
			description:
				"Start a run of the user's agent. Returns right away unless wait: true, which returns the agent's reply as `result` once the run finishes or asks a question.",
			inputSchema: {
				agentId: z.string(),
				instructions: z
					.string()
					.max(MAX_LAUNCH_PROMPT)
					.optional()
					.describe('What the agent should do this run; defaults to its saved instructions'),
				wait: z
					.boolean()
					.optional()
					.describe(
						`Wait for the run to finish and return its result (up to ${RUN_WAIT_MAX_MS / 60_000} minutes). Use it when you need the result to answer the user.`
					)
			}
		},
		async ({ agentId, instructions, wait }, extra) => {
			const db = getDb();
			const agent = getAgent(db, agentId);
			if (!agent || (agent.user_id !== ctx.userId && agent.user_id !== null)) {
				log.warn('start_agent not found', { userId: ctx.userId, agentId });
				return err('agent not found');
			}
			if (agent.user_id === null) {
				log.warn('start_agent builtin attempt', { userId: ctx.userId, agentId });
				return err('built-in agents run on their own schedule and cannot be started here');
			}
			const task = instructions?.trim() || undefined;
			// Free-form instructions would let a chat model direct arbitrary work
			// in the user's repositories, as for API keys.
			if (agent.coding_target && task) {
				return err('coding agents run their saved task; instructions are not accepted');
			}
			// An agent starting itself would chain runs without end.
			if (ctx.agentRunId && getAgentRun(db, ctx.agentRunId)?.agent_id === agentId) {
				log.warn('start_agent self start', { userId: ctx.userId, agentId });
				return err('an agent cannot start itself');
			}
			const running = getRunningAgentRun(db, agentId, ctx.userId);
			if (running) {
				// The run id lets the model wait on it, and the chat link to it.
				return err(
					`agent is already running (run ${running.id}); call get_agent_run with this runId and wait: true to wait for it`
				);
			}
			try {
				const { run, done } = await startAgentRun({
					agentId,
					trigger: 'manual',
					userId: ctx.userId,
					instructions: task
				});
				done.catch(() => undefined);
				log.info('start_agent', { userId: ctx.userId, agentId, runId: run.id, wait: !!wait });
				const settled = wait
					? await waitForRunToSettle(db, run, {
							timeoutMs: RUN_WAIT_MAX_MS,
							signal: extra.signal
						})
					: run;
				return runResult(db, settled, agent);
			} catch (e) {
				const message = e instanceof Error ? e.message : 'failed to start agent run';
				log.warn('start_agent failed', { userId: ctx.userId, agentId, error: message });
				return err(message);
			}
		}
	);

	server.registerTool(
		'get_agent_run',
		{
			description:
				"Get an agent run's status and, once it has finished, the agent's reply as `result`. With wait: true it returns once a running run has finished (or asks the user a question).",
			inputSchema: {
				runId: z.string(),
				wait: z
					.boolean()
					.optional()
					.describe(
						`Wait for a running run to finish (up to ${RUN_WAIT_MAX_MS / 60_000} minutes) before returning`
					)
			}
		},
		async ({ runId, wait }, extra) => {
			const db = getDb();
			const run = getAgentRun(db, runId);
			const agent = run ? getAgent(db, run.agent_id) : undefined;
			if (!run || !agent || run.user_id !== ctx.userId) {
				log.warn('get_agent_run not found', { userId: ctx.userId, runId });
				return err('agent run not found');
			}
			const settled =
				wait && run.status === 'running'
					? await waitForRunToSettle(db, run, { timeoutMs: RUN_WAIT_MAX_MS, signal: extra.signal })
					: run;
			log.info('get_agent_run', { userId: ctx.userId, runId, status: settled.status });
			return runResult(db, settled, agent);
		}
	);

	return server;
}
