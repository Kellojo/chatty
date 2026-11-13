import { describeError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { UIMessage } from 'ai';
import type { AgentTriggerConfig } from '$lib/types.js';
import { getDb, type Db } from '../db/index.js';
import { getAgent, type AgentRow } from '../db/repo/agents.js';
import {
	createAgentRun,
	finishAgentRun,
	getAgentRun,
	lastSuccessfulAgentRunStartedAt,
	type AgentRunRow
} from '../db/repo/agent-runs.js';
import { createConversation } from '../db/repo/conversations.js';
import { findRoleModel } from '../db/repo/models.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { runChatTurnHeadless } from '../chat/service.js';
import { abortStream } from '../chat/streams.js';
import { ensureAgentWorkspace } from '../workspaces.js';
import { extractionWindowNote, MEMORY_EXTRACTION_AGENT } from './builtin.js';
import {
	activeRunTurn,
	dismissRun,
	closeRunTurns,
	listActiveRunTurns,
	runsAsChats,
	runTurnContext
} from './run-lifecycle.js';

const log = createLogger('agents');

export interface StartAgentRunInput {
	agentId: string;
	trigger: 'schedule' | 'http' | 'manual' | 'event';
	userId: string;
	instructions?: string;
	/** The API key that started an HTTP run, for its usage statistics. */
	apiKeyId?: string;
}

export interface StartedAgentRun {
	run: AgentRunRow;
	done: Promise<AgentRunRow>;
}

/**
 * Stops a run: aborts its turn if one is streaming here, or dismisses the
 * question it waits on. False when there is nothing to stop.
 */
export function stopAgentRun(runId: string, db: Db = getDb()): boolean {
	const turn = activeRunTurn(runId);
	if (turn) return abortStream(turn.conversationId, 'stopped');
	const run = getAgentRun(db, runId);
	return run?.status === 'awaiting_input' ? dismissRun(db, run, 'Dismissed by user') : false;
}

let shuttingDown = false;

/**
 * Stops every running agent turn and refuses new runs for the rest of the
 * process's life. The wait is bounded so a stuck run can't hold up shutdown.
 */
export async function stopAllAgentRuns(timeoutMs: number): Promise<void> {
	shuttingDown = true;
	closeRunTurns();
	const turns = listActiveRunTurns();
	for (const turn of turns) abortStream(turn.conversationId, 'shutdown');
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	await Promise.race([Promise.allSettled(turns.map((t) => t.released)), timeout]);
	clearTimeout(timer);
}

/**
 * Starts an agent run: a conversation with the run's instructions as its first
 * message, answered by the chat engine. Runs of agents that may ask the user
 * are dispatched as visible chats; the others stay hidden `agent-run`
 * conversations. Coding agents start a T3 coding task instead.
 */
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

	const visible = runsAsChats(agent);
	const conversation = createConversation(db, input.userId, {
		kind: visible ? 'chat' : 'agent-run',
		origin: visible ? 'dispatch' : 'user',
		mode: 'agent',
		title: `${agent.name} · ${input.trigger} run`,
		providerId: ref.providerId,
		modelId: ref.modelId,
		agentId: agent.id,
		// A snapshot, as for chats started with an agent: later prompt edits
		// apply to new runs.
		systemPrompt: agent.system_prompt,
		maxSteps: agent.max_steps
	});
	const run = createAgentRun(db, {
		agentId: agent.id,
		userId: input.userId,
		trigger: input.trigger,
		conversationId: conversation.id,
		apiKeyId: input.apiKeyId
	});
	// Exists before the first turn, so the run's tools always have their sandbox.
	ensureAgentWorkspace(agent.id, run.id);
	publishServerEvent(input.userId, {
		type: 'agent.run.started',
		agentId: agent.id,
		runId: run.id,
		conversationId: conversation.id
	});

	const message: UIMessage = {
		id: randomUUID(),
		role: 'user',
		parts: [{ type: 'text', text: runInstructions(db, agent, input) }]
	};
	// Inside the chain: a failure building the context must still settle the run.
	const done = Promise.resolve()
		.then(() =>
			runChatTurnHeadless(
				input.userId,
				conversation,
				{ message },
				{ run: runTurnContext(db, agent, run, { resumed: false }) }
			)
		)
		.then(() => getAgentRun(db, run.id)!)
		.catch((e: unknown) => {
			// runChatTurnHeadless doesn't throw; this guards the bookkeeping around it.
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
	return { run, done };
}

/** The run's first message: what to do now, from the request, trigger or role. */
function runInstructions(db: Db, agent: AgentRow, input: StartAgentRunInput): string {
	let triggerConfig: AgentTriggerConfig = {};
	try {
		triggerConfig = JSON.parse(agent.trigger_config) as AgentTriggerConfig;
	} catch {
		// a malformed config only loses its instructions
	}
	const baseInstructions =
		input.instructions ??
		triggerConfig.instructions ??
		(agent.user_id === null
			? `Review recent conversations and distill durable long-term memory from them. Use search_chats with the "since" parameter to list them, read_chat to review their contents, list_concepts/search_memory to check what already exists, then create_concept/update_concept to persist.`
			: `Execute your task now. Trigger: ${input.trigger}.`);
	return agent.user_id === null && agent.name === MEMORY_EXTRACTION_AGENT
		? `${baseInstructions}\n\n${extractionWindowNote(lastSuccessfulAgentRunStartedAt(db, agent.id, input.userId))}`
		: baseInstructions;
}
