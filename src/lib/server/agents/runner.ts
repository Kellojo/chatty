import { describeError } from './errors.js';
import { randomUUID } from 'node:crypto';
import {
	convertToModelMessages,
	readUIMessageStream,
	stepCountIs,
	streamText,
	type UIMessage
} from 'ai';
import type { AgentTriggerConfig } from '$lib/types.js';
import { config } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { getAgent, setAgentRunTimes, type AgentRow } from '../db/repo/agents.js';
import {
	createAgentRun,
	finishAgentRun,
	getAgentRun,
	lastFinishedAgentRunAt,
	type AgentRunRow
} from '../db/repo/agent-runs.js';
import { createConversation } from '../db/repo/conversations.js';
import { createMessage, updateMessage } from '../db/repo/messages.js';
import { findModel, findRoleModel } from '../db/repo/models.js';
import { createProxyRequest, finalizeProxyRequest } from '../db/repo/proxy-requests.js';
import { cacheTokens, computeUsageCostUsd, type PricedUsage } from '../proxy/pricing.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { resolveModel } from '../llm/registry.js';
import { isRetryableModelError, resolveRefTargets } from '../llm/mapped.js';
import { resolveSkill, skillsIndexPrompt } from '../skills/scanner.js';
import { buildTools } from '../tools/registry.js';
import { ensureAgentWorkspace } from '../workspaces.js';

const log = createLogger('agents');

export interface StartAgentRunInput {
	agentId: string;
	trigger: 'schedule' | 'http' | 'manual' | 'event';
	userId: string;
	instructions?: string;
}

export interface StartedAgentRun {
	run: AgentRunRow;
	done: Promise<AgentRunRow>;
}

const runControllers = new Map<string, AbortController>();

export function stopAgentRun(runId: string): boolean {
	const controller = runControllers.get(runId);
	if (!controller) return false;
	controller.abort(new Error('Stopped by user'));
	return true;
}

const SHUTDOWN_MESSAGE = 'Interrupted by server shutdown';
/** Minimum gap between DB writes of a streaming assistant message. */
const PERSIST_INTERVAL_MS = 500;
const activeRuns = new Set<Promise<unknown>>();
let shuttingDown = false;

/**
 * Stops every running agent and refuses new runs for the rest of the process's
 * life. The wait is bounded so a stuck run can't hold up shutdown.
 */
export async function stopAllAgentRuns(timeoutMs: number): Promise<void> {
	shuttingDown = true;
	for (const controller of runControllers.values()) {
		controller.abort(new Error(SHUTDOWN_MESSAGE));
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	await Promise.race([Promise.allSettled(activeRuns), timeout]);
	clearTimeout(timer);
}

export async function startAgentRun(
	input: StartAgentRunInput,
	db: Db = getDb()
): Promise<StartedAgentRun> {
	if (shuttingDown) throw new Error('Server is shutting down');
	const agent = getAgent(db, input.agentId);
	if (!agent) throw new Error('Agent not found');
	if (agent.coding_target) {
		const { startCodingAgentRun } = await import('./coding-runs.js');
		return startCodingAgentRun(agent, input, db);
	}

	let ref: { providerId: string; modelId: string };
	if (agent.provider_id && agent.model_id) {
		ref = { providerId: agent.provider_id, modelId: agent.model_id };
	} else {
		const roleDefault =
			agent.user_id === null
				? (findRoleModel(db, 'memory') ?? findRoleModel(db, 'chat'))
				: findRoleModel(db, 'chat');
		if (!roleDefault) {
			throw new Error('Agent has no model configured and no default chat model exists');
		}
		ref = { providerId: roleDefault.provider_id, modelId: roleDefault.model_id };
	}
	const targets = resolveRefTargets(ref, db).targets;

	const conversation = createConversation(db, input.userId, {
		kind: 'agent-run',
		mode: 'agent',
		title: `${agent.name} · ${input.trigger} run`,
		providerId: ref.providerId,
		modelId: ref.modelId,
		agentId: agent.id
	});
	const run = createAgentRun(db, {
		agentId: agent.id,
		userId: input.userId,
		trigger: input.trigger,
		conversationId: conversation.id
	});

	// Anything that throws between creating the run row and handing off to `done`
	// would otherwise leave the run `running` forever, which also blocks the
	// agent's event triggers until a restart.
	let prepared: Awaited<ReturnType<typeof prepareRun>>;
	try {
		prepared = await prepareRun(db, agent, run, conversation.id, input);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		log.error('Agent run setup failed', { runId: run.id, agentId: agent.id, error: message });
		finishAgentRun(db, run.id, 'failed', message);
		publishServerEvent(input.userId, {
			type: 'agent.run.finished',
			agentId: agent.id,
			runId: run.id,
			status: 'failed'
		});
		throw e;
	}
	const { uiUserMessage, tools, close, system } = prepared;

	const controller = new AbortController();
	runControllers.set(run.id, controller);
	// Shutdown may have begun during the awaits above, after its abort sweep.
	if (shuttingDown) controller.abort(new Error(SHUTDOWN_MESSAGE));
	publishServerEvent(input.userId, { type: 'agent.run.started', agentId: agent.id, runId: run.id });

	const done = (async (): Promise<AgentRunRow> => {
		let errorText: string | null = null;
		const assistantMessageIds: string[] = [];
		let lastProgressAt = 0;
		// Assigned inside the try below so a failure still runs its cleanup.
		let modelMessages: Awaited<ReturnType<typeof convertToModelMessages>> = [];

		const runTarget = async (target: { providerId: string; modelId: string }) => {
			let contentful = false;
			const model = resolveModel(target);
			log.info('LLM inference started', {
				runId: run.id,
				agentId: agent.id,
				providerId: target.providerId,
				modelId: target.modelId
			});
			const startedAt = Date.now();
			let stepIndex = 0;
			let lastStepAt = startedAt;
			const priceRow = findModel(db, target.providerId, target.modelId);
			const recordStep = (patch: {
				status: 'complete' | 'failed';
				usage?: PricedUsage;
				error?: string | null;
			}) => {
				const now = Date.now();
				const row = createProxyRequest(db, {
					userId: input.userId,
					source: 'agent',
					conversationId: conversation.id,
					runId: run.id,
					stepIndex: stepIndex++,
					endpoint: 'streamText',
					requestedModel: target.modelId,
					stream: true
				});
				finalizeProxyRequest(db, row.id, {
					status: patch.status,
					latencyMs: now - lastStepAt,
					providerId: target.providerId,
					modelId: target.modelId,
					inputTokens: patch.usage?.inputTokens ?? null,
					outputTokens: patch.usage?.outputTokens ?? null,
					...cacheTokens(patch.usage),
					costUsd: computeUsageCostUsd(priceRow, patch.usage),
					error: patch.error ?? null
				});
				lastStepAt = now;
			};
			const result = streamText({
				model,
				system,
				messages: modelMessages,
				tools,
				stopWhen: stepCountIs(agent.max_steps ?? config.AGENT_MAX_STEPS),
				maxRetries: 2,
				abortSignal: controller.signal,
				onStepEnd: (step) => {
					recordStep({ status: 'complete', usage: step.usage });
				},
				onError: ({ error }) => {
					errorText = describeError(error);
					recordStep({ status: 'failed', error: errorText });
				}
			});
			// Each write re-serialises every part and blocks the event loop, so
			// persist at most every PERSIST_INTERVAL_MS and flush the latest parts
			// when a message ends.
			let unsaved: { id: string; parts: unknown[] } | null = null;
			let lastPersistAt = 0;
			const flushParts = () => {
				if (!unsaved) return;
				updateMessage(db, unsaved.id, { parts: unsaved.parts });
				unsaved = null;
			};
			try {
				for await (const message of readUIMessageStream({
					stream: result.toUIMessageStream({
						originalMessages: [uiUserMessage],
						generateMessageId: () => randomUUID()
					})
				})) {
					if (message.parts.length > 0) contentful = true;
					const now = Date.now();
					if (!assistantMessageIds.includes(message.id)) {
						flushParts();
						assistantMessageIds.push(message.id);
						createMessage(db, {
							id: message.id,
							conversationId: conversation.id,
							role: 'assistant',
							parts: message.parts,
							status: 'partial'
						});
						lastPersistAt = now;
					} else {
						unsaved = { id: message.id, parts: message.parts };
						if (now - lastPersistAt >= PERSIST_INTERVAL_MS) {
							lastPersistAt = now;
							flushParts();
						}
					}
					if (now - lastProgressAt >= 500) {
						lastProgressAt = now;
						publishServerEvent(input.userId, {
							type: 'agent.run.progress',
							agentId: agent.id,
							runId: run.id
						});
					}
				}
			} finally {
				flushParts();
			}
			const totalUsage = await result.usage;
			// Same shape as chat replies so the transcript can show generation info.
			const lastMessageId = assistantMessageIds.at(-1);
			if (contentful && lastMessageId) {
				updateMessage(db, lastMessageId, {
					usage: {
						providerId: target.providerId,
						modelId: target.modelId,
						inputTokens: totalUsage?.inputTokens ?? null,
						outputTokens: totalUsage?.outputTokens ?? null,
						totalTokens: totalUsage?.totalTokens ?? null,
						latencyMs: Date.now() - startedAt,
						costUsd: computeUsageCostUsd(priceRow, totalUsage)
					}
				});
			}
			log.info('LLM inference finished', {
				runId: run.id,
				agentId: agent.id,
				inputTokens: totalUsage?.inputTokens ?? null,
				outputTokens: totalUsage?.outputTokens ?? null,
				totalTokens: totalUsage?.totalTokens ?? null
			});
			return contentful;
		};

		try {
			modelMessages = await convertToModelMessages([uiUserMessage]);
			let lastError: unknown = null;
			for (let i = 0; i < targets.length; i++) {
				try {
					const contentful = await runTarget(targets[i]);
					if (!contentful && errorText) throw new Error(errorText);
					lastError = null;
					break;
				} catch (e) {
					lastError = e;
					if (
						assistantMessageIds.length === 0 &&
						i < targets.length - 1 &&
						isRetryableModelError(e)
					) {
						errorText = null;
						continue;
					}
					throw e;
				}
			}
			if (lastError) throw lastError;
		} catch (e) {
			if (!errorText) errorText = describeError(e);
		} finally {
			if (controller.signal.aborted) {
				const reason: unknown = controller.signal.reason;
				errorText = reason instanceof Error ? reason.message : 'Stopped by user';
			}
			runControllers.delete(run.id);
			try {
				for (const id of assistantMessageIds) {
					updateMessage(db, id, {
						status: errorText ? 'failed' : 'complete',
						error: errorText
					});
				}
				finishAgentRun(db, run.id, errorText ? 'failed' : 'success', errorText);
				setAgentRunTimes(db, agent.id, { lastRunAt: Date.now() });
				publishServerEvent(input.userId, {
					type: 'agent.run.finished',
					agentId: agent.id,
					runId: run.id,
					status: errorText ? 'failed' : 'success'
				});
			} finally {
				// MCP clients/child processes must be released even if the bookkeeping
				// above throws (the outer catch then marks the run failed).
				await close();
			}
		}
		return getAgentRun(db, run.id)!;
	})().catch((e) => {
		log.error('Agent run failed unexpectedly', {
			runId: run.id,
			agentId: agent.id,
			error: e instanceof Error ? e.message : String(e)
		});
		try {
			finishAgentRun(db, run.id, 'failed', describeError(e));
		} catch {
			// run row may already be finalized
		}
		return getAgentRun(db, run.id)!;
	});

	activeRuns.add(done);
	void done.finally(() => activeRuns.delete(done));

	return { run, done };
}

async function prepareRun(
	db: Db,
	agent: AgentRow,
	run: AgentRunRow,
	conversationId: string,
	input: StartAgentRunInput
) {
	const workspaceDir = ensureAgentWorkspace(agent.id, run.id);

	const triggerConfig = JSON.parse(agent.trigger_config) as AgentTriggerConfig;
	const instructions =
		input.instructions ??
		triggerConfig.instructions ??
		(agent.user_id === null
			? `Review conversations updated since ${new Date(lastFinishedAgentRunAt(db, agent.id, input.userId) ?? 0).toISOString()} and distill durable long-term memory from them. Use search_chats with the "since" parameter to list them, read_chat to review their contents, list_concepts/search_memory to check what already exists, then create_concept/update_concept to persist.`
			: `Execute your task now. Trigger: ${input.trigger}.`);
	const uiUserMessage: UIMessage = {
		id: randomUUID(),
		role: 'user',
		parts: [{ type: 'text', text: instructions }]
	};
	createMessage(db, {
		id: uiUserMessage.id,
		conversationId,
		role: 'user',
		parts: uiUserMessage.parts,
		status: 'complete'
	});

	const { tools, close } = await buildTools({
		userId: input.userId,
		memoryEnabled: true,
		workspaceDir,
		agentAllowlist: agent.tool_allowlist
			? (JSON.parse(agent.tool_allowlist) as string[])
			: undefined,
		author: agent.user_id === null ? 'system' : `agent:${agent.id}`,
		conversationId,
		agentRunId: run.id
	});

	try {
		const skillNames = JSON.parse(agent.skill_names) as string[];
		const boundSkillBodies: string[] = [];
		for (const name of skillNames) {
			const skill = resolveSkill(input.userId, name);
			if (skill?.enabled) boundSkillBodies.push(`### Skill: ${skill.title}\n${skill.body}`);
		}
		const boundSection =
			boundSkillBodies.length > 0
				? `\n\n## Bound skills\nThe following skills are pre-loaded for this run.\n\n${boundSkillBodies.join('\n\n')}`
				: '';
		const skillsIndex = 'load_skill' in tools ? skillsIndexPrompt(input.userId) : '';
		const system = `${agent.system_prompt}${boundSection}${skillsIndex ? `\n\n${skillsIndex}` : ''}\n\n---\nYou are running autonomously as the agent "${agent.name}" (trigger: ${input.trigger}). Current time: ${new Date().toLocaleString('en-US', { timeZone: config.TZ })} (${config.TZ}). Do not ask the user questions; no one is watching live.`;
		return { uiUserMessage, tools, close, system };
	} catch (e) {
		await close().catch(() => undefined);
		throw e;
	}
}
