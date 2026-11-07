import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	agentCreateSchema,
	agentPatchSchema,
	prepareAgentCreate,
	prepareAgentUpdate
} from '../../agentInput.js';
import { getDb } from '../../db/index.js';
import {
	createAgent,
	deleteAgent,
	getAgent,
	listAgents,
	toPublic,
	updateAgent
} from '../../db/repo/agents.js';
import { createLogger } from '../../logger.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const log = createLogger('mcp:agents');

const MODEL_FIELD_DESCRIPTIONS = {
	providerId: 'Provider id (must be given together with modelId)',
	modelId: 'Model id (must be given together with providerId)'
};

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
			log.info('list_agents', { userId: ctx.userId, count: rows.length });
			return text(
				JSON.stringify(
					rows.map((r) => {
						const pub = toPublic(r);
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
			description: 'Get the full configuration of one agent by id',
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
			return text(JSON.stringify(toPublic(agent)));
		}
	);

	server.registerTool(
		'create_agent',
		{
			description:
				'Create a new agent for the current user. triggerType persona makes it selectable in chat; schedule requires a cron expression; event requires an event name.',
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
			return text(JSON.stringify(toPublic(agent)));
		}
	);

	server.registerTool(
		'update_agent',
		{
			description:
				'Update an existing agent owned by the current user. Only provided fields are changed. Built-in agents cannot be modified.',
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
			return text(JSON.stringify(toPublic(updated!)));
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

	return server;
}
