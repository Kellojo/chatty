// Coding agents: agents whose runs are T3 coding tasks instead of a model loop.
// A run launches a task with the agent's saved target and prompt, stays
// `running` while the remote agent works (including while it waits for an
// approval), and is settled when the follower reports the thread finished.

import type { AgentCodingTarget } from '$lib/coding-environments.js';
import type { AgentTriggerConfig, ServerEvent } from '$lib/types.js';
import type { AgentCodingTargetBody } from '../agentInput.js';
import { getDb, type Db } from '../db/index.js';
import {
	createAgentRun,
	finishAgentRun,
	getAgentRun,
	getRunningAgentRunByConversation,
	setAgentRunConversation,
	type AgentRunRow
} from '../db/repo/agent-runs.js';
import { parseCodingTarget, setAgentRunTimes, type AgentRow } from '../db/repo/agents.js';
import { getCodingConversation } from '../db/repo/coding-conversations.js';
import { abortStream } from '../chat/streams.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import {
	interruptCodingTaskRemotely,
	launchCodingTask,
	MAX_LAUNCH_PROMPT,
	resolveCodingTarget
} from '../t3/tasks.js';
import type { StartAgentRunInput, StartedAgentRun } from './runner.js';

const log = createLogger('agents');

/**
 * Checks a coding target the user wants to save on an agent: the environment
 * must be theirs and enabled, and the project must exist on it.
 */
export async function resolveAgentCodingTarget(
	userId: string,
	body: AgentCodingTargetBody,
	db: Db = getDb()
): Promise<AgentCodingTarget> {
	const { project } = await resolveCodingTarget(userId, body, db);
	return {
		environmentId: body.environmentId,
		projectId: project.id,
		projectTitle: project.title,
		providerInstanceId: body.providerInstanceId,
		model: body.model,
		autonomy: body.autonomy,
		workspaceMode: body.workspaceMode,
		baseBranch: body.workspaceMode === 'worktree' ? (body.baseBranch ?? null) : null
	};
}

/** The first message sent to the coding agent: the agent's task plus this run's instructions. */
export function buildCodingPrompt(agent: AgentRow, instructions: string | undefined): string {
	let triggerInstructions: string | undefined;
	try {
		triggerInstructions = (JSON.parse(agent.trigger_config) as AgentTriggerConfig).instructions;
	} catch {
		triggerInstructions = undefined;
	}
	const extra = (instructions ?? triggerInstructions ?? '').trim();
	const prompt = extra ? `${agent.system_prompt.trim()}\n\n${extra}` : agent.system_prompt.trim();
	return prompt.slice(0, MAX_LAUNCH_PROMPT);
}

function finish(
	db: Db,
	agent: Pick<AgentRow, 'id'>,
	run: AgentRunRow,
	status: 'success' | 'failed',
	error: string | null
): void {
	finishAgentRun(db, run.id, status, error);
	setAgentRunTimes(db, agent.id, { lastRunAt: Date.now() });
	publishServerEvent(run.user_id, {
		type: 'agent.run.finished',
		agentId: agent.id,
		runId: run.id,
		status
	});
}

export async function startCodingAgentRun(
	agent: AgentRow,
	input: StartAgentRunInput,
	db: Db = getDb()
): Promise<StartedAgentRun> {
	const target = parseCodingTarget(agent);
	if (!target) throw new Error('Agent has no coding target');
	// Only the owner's environments are reachable (launchCodingTask checks the
	// environment belongs to the run's user); built-in agents never get here.
	if (agent.user_id === null || agent.user_id !== input.userId) {
		throw new Error('Coding agents only run for their owner');
	}

	// The run row exists (and is linked inside the task's creation) before the
	// task's `chat.created` goes out, so event agents can tell it came from an
	// agent run.
	const run = createAgentRun(db, {
		agentId: agent.id,
		userId: input.userId,
		trigger: input.trigger
	});
	publishServerEvent(input.userId, { type: 'agent.run.started', agentId: agent.id, runId: run.id });

	try {
		await launchCodingTask(
			input.userId,
			{
				environmentId: target.environmentId,
				projectId: target.projectId,
				providerInstanceId: target.providerInstanceId,
				model: target.model,
				autonomy: target.autonomy,
				workspaceMode: target.workspaceMode,
				baseBranch: target.baseBranch,
				prompt: buildCodingPrompt(agent, input.instructions),
				title: `${agent.name} · ${input.trigger} run`
			},
			db,
			{ onCreated: (conversationId) => setAgentRunConversation(db, run.id, conversationId) }
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		log.error('Coding agent run failed to launch', {
			runId: run.id,
			agentId: agent.id,
			error: message
		});
		finish(db, agent, getAgentRun(db, run.id)!, 'failed', message);
		throw e instanceof Error ? e : new Error(message);
	}

	// The run row is linked to the task; the thread finishing settles it later.
	// Callers that await `done` (scheduler, event dispatch) don't need to hold on
	// for hours: the agent counts as busy while the run row is `running`.
	const linked = getAgentRun(db, run.id)!;
	return { run: linked, done: Promise.resolve(linked) };
}

/** Settles the coding agent run waiting on the finished thread, if any. */
export function settleCodingAgentRun(
	event: Extract<ServerEvent, { type: 'coding.thread.finished' }>,
	db: Db = getDb()
): void {
	try {
		const run = getRunningAgentRunByConversation(db, event.conversationId);
		if (!run) return;
		const coding = getCodingConversation(db, event.conversationId);
		const status = event.status === 'completed' ? 'success' : 'failed';
		const error =
			event.status === 'completed'
				? null
				: event.status === 'interrupted'
					? 'The coding agent was interrupted'
					: (coding?.last_error ?? 'The coding agent failed');
		finish(db, { id: run.agent_id }, run, status, error);
	} catch (e) {
		log.error('Failed to settle coding agent run', {
			conversationId: event.conversationId,
			error: e instanceof Error ? e.message : String(e)
		});
	}
}

/** Fails the coding agent run waiting on a task that can no longer finish, if any. */
export function failCodingAgentRunForTask(
	conversationId: string,
	error: string,
	db: Db = getDb()
): void {
	const run = getRunningAgentRunByConversation(db, conversationId);
	if (run) finish(db, { id: run.agent_id }, run, 'failed', error);
}

/**
 * Stops a coding agent run: interrupts the remote agent's current turn (if
 * this server is streaming it) and marks the run as stopped. The task itself
 * stays, so the user can look at or continue what was done.
 */
export function stopCodingAgentRun(runId: string, db: Db = getDb()): boolean {
	const run = getAgentRun(db, runId);
	if (!run || run.status !== 'running' || !run.conversation_id) return false;
	if (!getCodingConversation(db, run.conversation_id)) return false;
	// Without a live stream here (follower gave up, server restarted), nothing
	// else would stop the remote agent.
	if (!abortStream(run.conversation_id)) {
		void interruptCodingTaskRemotely(run.user_id, run.conversation_id, db);
	}
	finish(db, { id: run.agent_id }, run, 'failed', 'Stopped by user');
	return true;
}
