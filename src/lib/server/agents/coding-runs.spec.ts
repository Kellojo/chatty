import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCodingTarget } from '$lib/coding-environments.js';

const launchCodingTask = vi.fn();
const interruptCodingTaskRemotely = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock('../t3/tasks.js', () => ({
	MAX_LAUNCH_PROMPT: 20_000,
	launchCodingTask: (...args: unknown[]) => launchCodingTask(...args),
	interruptCodingTaskRemotely: (...args: unknown[]) => interruptCodingTaskRemotely(...args),
	resolveCodingTarget: vi.fn()
}));
const abortStream = vi.fn();
vi.mock('../chat/streams.js', () => ({ abortStream: (id: string) => abortStream(id) }));
const published: { userId: string; event: { type: string } }[] = [];
vi.mock('../events/bus.js', () => ({
	publishServerEvent: (userId: string, event: { type: string }) => published.push({ userId, event })
}));

const { openDatabase } = await import('../db/index.js');
const { createAgent } = await import('../db/repo/agents.js');
const { createAgentRun, failRunningAgentRuns, getAgentRun } =
	await import('../db/repo/agent-runs.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { buildCodingPrompt, settleCodingAgentRun, startCodingAgentRun, stopCodingAgentRun } =
	await import('./coding-runs.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;

const target: AgentCodingTarget = {
	environmentId: 'env-1',
	projectId: 'proj-1',
	projectTitle: 'Project',
	providerInstanceId: 'codex',
	model: 'gpt-x',
	autonomy: 'supervised',
	workspaceMode: 'worktree',
	baseBranch: 'main'
};

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
		 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
	).run();
	launchCodingTask.mockReset();
	abortStream.mockReset();
	interruptCodingTaskRemotely.mockClear();
	published.length = 0;
});

function seedCodingAgent(triggerConfig: Record<string, unknown> = {}) {
	return createAgent(db, 'u1', {
		name: 'deps',
		systemPrompt: 'Update dependencies.',
		triggerType: 'manual',
		triggerConfig,
		codingTarget: target
	});
}

/** A coding task conversation with the given status, as launchCodingTask leaves it. */
function seedCodingConversation(status = 'running', threadId: string | null = 'thread-1') {
	const conv = createConversation(db, 'u1', { kind: 'chat', mode: 'agent' });
	db.prepare(
		`INSERT INTO coding_conversations (conversation_id, environment_id, project_id, project_title,
		   thread_id, provider_instance_id, model, runtime_mode, workspace_mode, status, created_at, updated_at)
		 VALUES (?, NULL, 'proj-1', 'Project', ?, 'codex', 'gpt-x', 'approval-required', 'worktree', ?, 0, 0)`
	).run(conv.id, threadId, status);
	return conv.id;
}

describe('buildCodingPrompt', () => {
	it('appends run instructions to the saved task', () => {
		const agent = seedCodingAgent({ instructions: 'trigger text' });
		expect(buildCodingPrompt(agent, 'run text')).toBe('Update dependencies.\n\nrun text');
		expect(buildCodingPrompt(agent, undefined)).toBe('Update dependencies.\n\ntrigger text');
	});

	it('sends just the task when there are no instructions', () => {
		const agent = seedCodingAgent();
		expect(buildCodingPrompt(agent, '  ')).toBe('Update dependencies.');
	});
});

describe('startCodingAgentRun', () => {
	it('launches the task with the saved target and links the run before chat.created', async () => {
		const agent = seedCodingAgent();
		let linkedAtCreation: string | null = null;
		launchCodingTask.mockImplementation(
			async (
				_userId: string,
				_input: unknown,
				_db: unknown,
				opts: { onCreated: (id: string) => void }
			) => {
				const conversationId = seedCodingConversation('starting');
				opts.onCreated(conversationId);
				linkedAtCreation = (
					db.prepare('SELECT conversation_id FROM agent_runs').get() as {
						conversation_id: string;
					}
				).conversation_id;
				return { conversation: { id: conversationId } };
			}
		);
		const { run, done } = await startCodingAgentRun(
			agent,
			{
				agentId: agent.id,
				trigger: 'manual',
				userId: 'u1',
				instructions: 'also bump node'
			},
			db
		);
		expect(launchCodingTask).toHaveBeenCalledWith(
			'u1',
			expect.objectContaining({
				environmentId: 'env-1',
				projectId: 'proj-1',
				autonomy: 'supervised',
				prompt: 'Update dependencies.\n\nalso bump node'
			}),
			db,
			expect.any(Object)
		);
		expect(linkedAtCreation).toBe(run.conversation_id);
		expect(run.status).toBe('running');
		expect((await done).status).toBe('running');
	});

	it('records a failed run when the launch fails', async () => {
		const agent = seedCodingAgent();
		launchCodingTask.mockRejectedValue(new Error('environment unreachable'));
		await expect(
			startCodingAgentRun(agent, { agentId: agent.id, trigger: 'schedule', userId: 'u1' }, db)
		).rejects.toThrow('environment unreachable');
		const row = db.prepare('SELECT status, error FROM agent_runs').get() as {
			status: string;
			error: string;
		};
		expect(row).toEqual({ status: 'failed', error: 'environment unreachable' });
		expect(published.map((p) => p.event.type)).toEqual(['agent.run.started', 'agent.run.finished']);
	});

	it('refuses to run for anyone but the owner', async () => {
		const agent = seedCodingAgent();
		await expect(
			startCodingAgentRun(agent, { agentId: agent.id, trigger: 'event', userId: 'u2' }, db)
		).rejects.toThrow('owner');
		expect(launchCodingTask).not.toHaveBeenCalled();
	});
});

describe('settleCodingAgentRun', () => {
	function seedRun() {
		const agent = seedCodingAgent();
		const conversationId = seedCodingConversation();
		const run = createAgentRun(db, {
			agentId: agent.id,
			userId: 'u1',
			trigger: 'manual',
			conversationId
		});
		return { agent, run, conversationId };
	}

	it('marks the run successful when the thread completes', () => {
		const { run, conversationId } = seedRun();
		settleCodingAgentRun(
			{
				type: 'coding.thread.finished',
				conversationId,
				status: 'completed',
				branch: null,
				prUrl: null
			},
			db
		);
		expect(getAgentRun(db, run.id)?.status).toBe('success');
		expect(published.at(-1)?.event).toMatchObject({
			type: 'agent.run.finished',
			status: 'success'
		});
	});

	it('fails the run when the thread is interrupted', () => {
		const { run, conversationId } = seedRun();
		settleCodingAgentRun(
			{
				type: 'coding.thread.finished',
				conversationId,
				status: 'interrupted',
				branch: null,
				prUrl: null
			},
			db
		);
		expect(getAgentRun(db, run.id)).toMatchObject({
			status: 'failed',
			error: 'The coding agent was interrupted'
		});
	});

	it('ignores threads no run is waiting on', () => {
		const conversationId = seedCodingConversation();
		settleCodingAgentRun(
			{
				type: 'coding.thread.finished',
				conversationId,
				status: 'completed',
				branch: null,
				prUrl: null
			},
			db
		);
		expect(published).toHaveLength(0);
	});
});

describe('stopCodingAgentRun', () => {
	it('interrupts the task and marks the run stopped', () => {
		const agent = seedCodingAgent();
		const conversationId = seedCodingConversation();
		const run = createAgentRun(db, {
			agentId: agent.id,
			userId: 'u1',
			trigger: 'manual',
			conversationId
		});
		abortStream.mockReturnValue(true);
		expect(stopCodingAgentRun(run.id, db)).toBe(true);
		expect(abortStream).toHaveBeenCalledWith(conversationId);
		expect(interruptCodingTaskRemotely).not.toHaveBeenCalled();
		expect(getAgentRun(db, run.id)).toMatchObject({ status: 'failed', error: 'Stopped by user' });
	});

	it('interrupts the remote run directly when nothing streams it here', () => {
		const agent = seedCodingAgent();
		const conversationId = seedCodingConversation();
		const run = createAgentRun(db, {
			agentId: agent.id,
			userId: 'u1',
			trigger: 'manual',
			conversationId
		});
		abortStream.mockReturnValue(false);
		expect(stopCodingAgentRun(run.id, db)).toBe(true);
		expect(interruptCodingTaskRemotely).toHaveBeenCalledWith('u1', conversationId, db);
		expect(getAgentRun(db, run.id)).toMatchObject({ status: 'failed', error: 'Stopped by user' });
	});

	it('does nothing for runs without a coding task', () => {
		const agent = seedCodingAgent();
		const run = createAgentRun(db, { agentId: agent.id, userId: 'u1', trigger: 'manual' });
		expect(stopCodingAgentRun(run.id, db)).toBe(false);
	});
});

describe('failRunningAgentRuns', () => {
	it('keeps coding runs whose task is still live across a restart', () => {
		const agent = seedCodingAgent();
		const live = createAgentRun(db, {
			agentId: agent.id,
			userId: 'u1',
			trigger: 'manual',
			conversationId: seedCodingConversation('awaiting_input')
		});
		const ended = createAgentRun(db, {
			agentId: agent.id,
			userId: 'u1',
			trigger: 'manual',
			conversationId: seedCodingConversation('idle')
		});
		const plain = createAgentRun(db, { agentId: agent.id, userId: 'u1', trigger: 'manual' });
		expect(failRunningAgentRuns(db)).toBe(2);
		expect(getAgentRun(db, live.id)?.status).toBe('running');
		expect(getAgentRun(db, ended.id)?.status).toBe('failed');
		expect(getAgentRun(db, plain.id)?.status).toBe('failed');
	});
});
