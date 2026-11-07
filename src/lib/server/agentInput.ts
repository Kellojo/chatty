// Shared validation for creating/updating agents. Used by the REST API
// (/api/agents) and the `agents` MCP tools so both enforce the same rules.
import { z } from 'zod';
import { AGENT_EVENT_NAMES, type AgentTriggerConfig, type AgentTriggerType } from '$lib/types.js';
import { computeNextRunAt, isValidCron } from './agents/scheduler.js';
import type { Db } from './db/index.js';
import type { AgentRow, CreateAgentInput, UpdateAgentInput } from './db/repo/agents.js';
import { isSelectableModelRef } from './llm/mapped.js';

export const AGENT_TRIGGER_TYPES = ['persona', 'schedule', 'http', 'manual', 'event'] as const;

export const agentTriggerConfigSchema = z.object({
	cron: z.string().optional(),
	instructions: z.string().max(4000).optional(),
	event: z.enum(AGENT_EVENT_NAMES).optional(),
	every: z.number().int().min(1).max(1000).optional()
});

export const agentCreateSchema = z.object({
	name: z.string().trim().min(1).max(100),
	description: z.string().max(500).optional(),
	systemPrompt: z.string().trim().min(1).max(20000),
	providerId: z.string().min(1).nullable().optional(),
	modelId: z.string().min(1).nullable().optional(),
	skillNames: z.array(z.string().min(1)).max(50).optional(),
	toolAllowlist: z.array(z.string().min(1)).max(200).nullable().optional(),
	triggerType: z.enum(AGENT_TRIGGER_TYPES),
	triggerConfig: agentTriggerConfigSchema.optional(),
	maxSteps: z.number().int().min(1).max(100).nullable().optional(),
	enabled: z.boolean().optional()
});

export const agentPatchSchema = agentCreateSchema.partial();

export type AgentCreateBody = z.infer<typeof agentCreateSchema>;
export type AgentPatchBody = z.infer<typeof agentPatchSchema>;

export type AgentInputResult<T> = { ok: true; value: T } | { ok: false; error: string };

function validateTrigger(
	triggerType: AgentTriggerType,
	triggerConfig: AgentTriggerConfig
): string | null {
	if (triggerType === 'schedule') {
		if (!triggerConfig.cron) return 'Schedule trigger requires a cron expression';
		if (!isValidCron(triggerConfig.cron)) return 'Invalid cron expression';
	}
	if (triggerType === 'event' && !triggerConfig.event) {
		return 'Event trigger requires an event name';
	}
	return null;
}

function validateModel(
	db: Db,
	providerId: string | null | undefined,
	modelId: string | null | undefined
): string | null {
	if ((providerId == null) !== (modelId == null)) {
		return 'providerId and modelId must be provided together';
	}
	if (providerId && modelId && !isSelectableModelRef({ providerId, modelId }, db)) {
		return 'Unknown model';
	}
	return null;
}

function nextRunAtFor(
	triggerType: AgentTriggerType,
	triggerConfig: AgentTriggerConfig,
	enabled: boolean
): number | null {
	return triggerType === 'schedule' && enabled ? computeNextRunAt(triggerConfig.cron!) : null;
}

/**
 * Validates a create request (already shape-checked by `agentCreateSchema`) and
 * returns the repo input, including the computed `nextRunAt`.
 */
export function prepareAgentCreate(
	db: Db,
	input: AgentCreateBody
): AgentInputResult<CreateAgentInput> {
	const triggerConfig = input.triggerConfig ?? {};
	const enabled = input.enabled !== false;
	const error =
		validateTrigger(input.triggerType, triggerConfig) ??
		validateModel(db, input.providerId, input.modelId);
	if (error) return { ok: false, error };
	return {
		ok: true,
		value: {
			...input,
			triggerConfig,
			enabled,
			nextRunAt: nextRunAtFor(input.triggerType, triggerConfig, enabled)
		}
	};
}

export interface PrepareAgentUpdateOptions {
	/** Merge a partial `triggerConfig` into the stored one instead of replacing it. */
	mergeTriggerConfig?: boolean;
}

/**
 * Validates a patch against the agent's resulting state (stored values with the
 * patch applied) and returns the repo update, recomputing `nextRunAt` whenever
 * the trigger or enabled state changes. Ownership checks are the caller's job.
 */
export function prepareAgentUpdate(
	db: Db,
	existing: AgentRow,
	patch: AgentPatchBody,
	options: PrepareAgentUpdateOptions = {}
): AgentInputResult<UpdateAgentInput> {
	const existingConfig = JSON.parse(existing.trigger_config) as AgentTriggerConfig;
	const triggerConfig =
		patch.triggerConfig === undefined
			? existingConfig
			: options.mergeTriggerConfig
				? { ...existingConfig, ...patch.triggerConfig }
				: patch.triggerConfig;
	const triggerType = patch.triggerType ?? (existing.trigger_type as AgentTriggerType);
	const enabled = patch.enabled ?? existing.enabled === 1;

	const triggerChanged =
		patch.triggerType !== undefined ||
		patch.triggerConfig !== undefined ||
		patch.enabled !== undefined;
	if (triggerChanged) {
		const error = validateTrigger(triggerType, triggerConfig);
		if (error) return { ok: false, error };
	}

	if (patch.providerId !== undefined || patch.modelId !== undefined) {
		const providerId = patch.providerId !== undefined ? patch.providerId : existing.provider_id;
		const modelId = patch.modelId !== undefined ? patch.modelId : existing.model_id;
		const error = validateModel(db, providerId, modelId);
		if (error) return { ok: false, error };
	}

	return {
		ok: true,
		value: {
			...patch,
			triggerConfig: patch.triggerConfig !== undefined ? triggerConfig : undefined,
			...(triggerChanged ? { nextRunAt: nextRunAtFor(triggerType, triggerConfig, enabled) } : {})
		}
	};
}
