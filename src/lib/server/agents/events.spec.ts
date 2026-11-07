import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db/index.js';
import { createAgent, setAgentOverride } from '../db/repo/agents.js';
import { createAgentRun, finishAgentRun } from '../db/repo/agent-runs.js';
import { createConversation } from '../db/repo/conversations.js';
import { emitAgentEvent, handleServerEvent } from './events.js';

let db: Db;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
		 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
	).run();
});

function seedEventAgent(
	userId: string | null,
	triggerConfig: {
		event: 'memory.changed' | 'chat.created' | 'chat.message_completed';
		every?: number;
		instructions?: string;
	}
) {
	return createAgent(db, userId, {
		name: 'ev',
		systemPrompt: 'x',
		triggerType: 'event',
		triggerConfig
	});
}

describe('emitAgentEvent', () => {
	it('runs on each occurrence when every is 1 or absent', async () => {
		const agent = seedEventAgent('u1', { event: 'memory.changed' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', { path: 'a.md' }, db, runFn);
		await emitAgentEvent('memory.changed', 'u1', { path: 'b.md' }, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(2);
		expect(runFn).toHaveBeenNthCalledWith(1, agent.id, 'u1', expect.any(String));
	});

	it('runs only on every Nth occurrence', async () => {
		seedEventAgent('u1', { event: 'memory.changed', every: 3 });
		const runFn = vi.fn().mockResolvedValue(undefined);
		for (let i = 0; i < 6; i++) {
			await emitAgentEvent('memory.changed', 'u1', { i }, db, runFn);
		}
		expect(runFn).toHaveBeenCalledTimes(2);
		expect(runFn.mock.calls[0][2]).toContain('occurrence #3');
		expect(runFn.mock.calls[1][2]).toContain('occurrence #6');
	});

	it('keeps per-user counters independent', async () => {
		const agent = seedEventAgent(null, { event: 'chat.created', every: 2 });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('chat.created', 'u1', {}, db, runFn);
		await emitAgentEvent('chat.created', 'u2', {}, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
		await emitAgentEvent('chat.created', 'u1', {}, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
		expect(runFn).toHaveBeenLastCalledWith(agent.id, 'u1', expect.any(String));
		await emitAgentEvent('chat.created', 'u2', {}, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(2);
		expect(runFn).toHaveBeenLastCalledWith(agent.id, 'u2', expect.any(String));
	});

	it('skips a built-in agent for users whose override disables it', async () => {
		const agent = seedEventAgent(null, { event: 'memory.changed' });
		setAgentOverride(db, 'u2', agent.id, false);
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u2', {}, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
		await emitAgentEvent('memory.changed', 'u1', {}, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
		expect(runFn).toHaveBeenCalledWith(agent.id, 'u1', expect.any(String));
	});

	it('runs a row-disabled built-in for users with an enabling override', async () => {
		const agent = seedEventAgent(null, { event: 'memory.changed' });
		db.prepare('UPDATE agents SET enabled = 0 WHERE id = ?').run(agent.id);
		setAgentOverride(db, 'u1', agent.id, true);
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', {}, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
		expect(runFn).toHaveBeenCalledWith(agent.id, 'u1', expect.any(String));
	});

	it('skips a row-disabled built-in without an enabling override', async () => {
		const agent = seedEventAgent(null, { event: 'memory.changed' });
		db.prepare('UPDATE agents SET enabled = 0 WHERE id = ?').run(agent.id);
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', {}, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
	});

	it("does not trigger a user-owned agent for another user's event", async () => {
		seedEventAgent('u2', { event: 'memory.changed' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', {}, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
	});

	it('queues events while the agent has a running run', async () => {
		const agent = seedEventAgent('u1', { event: 'memory.changed' });
		const run = createAgentRun(db, { agentId: agent.id, userId: 'u1', trigger: 'manual' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', {}, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
		finishAgentRun(db, run.id, 'success');
		await emitAgentEvent('memory.changed', 'u1', {}, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
		expect(runFn.mock.calls[0][2]).toContain('occurrence #1');
	});

	it('includes event name, occurrence number and payload in the instructions', async () => {
		seedEventAgent('u1', { event: 'chat.message_completed' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('chat.message_completed', 'u1', { conversationId: 'c1' }, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
		const instructions = runFn.mock.calls[0][2] as string;
		expect(instructions).toBe(
			'The event "chat.message_completed" just occurred (occurrence #1). Payload: {"conversationId":"c1"}. Act on it according to your role.'
		);
	});

	it('prefixes triggerConfig.instructions when set', async () => {
		seedEventAgent('u1', { event: 'memory.changed', instructions: 'Clean up old memories.' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', { path: 'x.md' }, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
		expect(runFn.mock.calls[0][2]).toBe(
			'Clean up old memories.\n\nTriggering event: "memory.changed" (occurrence #1). Payload: {"path":"x.md"}'
		);
	});

	it('ignores agents subscribed to a different event', async () => {
		seedEventAgent('u1', { event: 'chat.created' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', {}, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
	});

	it('never throws when the database lookup fails', async () => {
		const closed = openDatabase(':memory:');
		closed.close();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await expect(
			emitAgentEvent('memory.changed', 'u1', {}, closed, vi.fn())
		).resolves.toBeUndefined();
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});
});

describe('handleServerEvent', () => {
	it('dispatches agent-trigger events with their payload', async () => {
		const agent = seedEventAgent('u1', { event: 'chat.created' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		handleServerEvent('u1', { type: 'chat.created', conversationId: 'c1' }, db, runFn);
		await vi.waitFor(() => expect(runFn).toHaveBeenCalledTimes(1));
		expect(runFn).toHaveBeenCalledWith(
			agent.id,
			'u1',
			expect.stringContaining('"conversationId":"c1"')
		);
	});

	it('keeps the memory.changed payload shape', async () => {
		seedEventAgent('u1', { event: 'memory.changed' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		handleServerEvent(
			'u1',
			{ type: 'memory.changed', scope: 'user', path: 'x.md', action: 'create', author: 'user:u1' },
			db,
			runFn
		);
		await vi.waitFor(() => expect(runFn).toHaveBeenCalledTimes(1));
		expect(runFn.mock.calls[0][2]).toContain(
			'"scope":"user","path":"x.md","action":"create","author":"user:u1"'
		);
	});

	it('ignores non-agent event types', async () => {
		seedEventAgent('u1', { event: 'memory.changed' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		handleServerEvent('u1', { type: 'chat.stream.finished', conversationId: 'c1' }, db, runFn);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(runFn).not.toHaveBeenCalled();
	});
});

describe('event run concurrency', () => {
	function deferred() {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => (resolve = r));
		return { promise, resolve };
	}

	it('starts only one run for events arriving in the same tick', async () => {
		const agent = seedEventAgent('u1', { event: 'memory.changed' });
		const gate = deferred();
		const runFn = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
		await Promise.all([
			emitAgentEvent('memory.changed', 'u1', { path: 'a.md' }, db, runFn),
			emitAgentEvent('memory.changed', 'u1', { path: 'b.md' }, db, runFn)
		]);
		expect(runFn).toHaveBeenCalledTimes(1);
		expect(runFn.mock.calls[0][2]).toContain('a.md');
		// The second event waited and runs once the first run is done.
		gate.resolve();
		await vi.waitFor(() => expect(runFn).toHaveBeenCalledTimes(2));
		expect(runFn).toHaveBeenLastCalledWith(agent.id, 'u1', expect.stringContaining('b.md'));
	});

	it('does not wait for a run before dispatching to other agents', async () => {
		const first = seedEventAgent('u1', { event: 'memory.changed' });
		const second = seedEventAgent('u1', { event: 'memory.changed' });
		const runFn = vi.fn().mockReturnValue(new Promise(() => undefined));
		await emitAgentEvent('memory.changed', 'u1', {}, db, runFn);
		expect(runFn.mock.calls.map((c) => c[0]).sort()).toEqual([first.id, second.id].sort());
	});

	it('coalesces events queued during an external run into one follow-up run', async () => {
		const agent = seedEventAgent('u1', { event: 'memory.changed' });
		const run = createAgentRun(db, { agentId: agent.id, userId: 'u1', trigger: 'manual' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', { path: 'a.md' }, db, runFn);
		await emitAgentEvent('memory.changed', 'u1', { path: 'b.md' }, db, runFn);
		expect(runFn).not.toHaveBeenCalled();

		finishAgentRun(db, run.id, 'success');
		handleServerEvent(
			'u1',
			{ type: 'agent.run.finished', agentId: agent.id, runId: run.id, status: 'success' },
			db,
			runFn
		);
		expect(runFn).toHaveBeenCalledTimes(1);
		const instructions = runFn.mock.calls[0][2] as string;
		expect(instructions).toContain('occurrence #1');
		expect(instructions).toContain('occurrence #2');
		expect(instructions).toContain('b.md');
	});
});

describe('coding agents', () => {
	const codingTarget = {
		environmentId: 'env-1',
		projectId: 'proj-1',
		projectTitle: 'Project',
		providerInstanceId: 'codex',
		model: 'gpt-x',
		autonomy: 'supervised' as const,
		workspaceMode: 'worktree' as const,
		baseBranch: 'main'
	};

	function seedCodingEventAgent(event: 'chat.created' | 'coding.thread.finished') {
		return createAgent(db, 'u1', {
			name: 'coder',
			systemPrompt: 'x',
			triggerType: 'event',
			triggerConfig: { event },
			codingTarget
		});
	}

	it('ignores events about conversations created by agent runs', async () => {
		const agent = seedCodingEventAgent('chat.created');
		const conv = createConversation(db, 'u1', { kind: 'chat' });
		createAgentRun(db, {
			agentId: agent.id,
			userId: 'u1',
			trigger: 'event',
			conversationId: conv.id
		});
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('chat.created', 'u1', { conversationId: conv.id }, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
	});

	it('still runs for conversations the user started', async () => {
		seedCodingEventAgent('chat.created');
		const conv = createConversation(db, 'u1', { kind: 'chat' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('chat.created', 'u1', { conversationId: conv.id }, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
	});

	it('lets model agents react to coding agent runs finishing', async () => {
		const coder = seedCodingEventAgent('coding.thread.finished');
		const reviewer = createAgent(db, 'u1', {
			name: 'reviewer',
			systemPrompt: 'x',
			triggerType: 'event',
			triggerConfig: { event: 'coding.thread.finished' }
		});
		const conv = createConversation(db, 'u1', { kind: 'chat' });
		createAgentRun(db, {
			agentId: coder.id,
			userId: 'u1',
			trigger: 'manual',
			conversationId: conv.id
		});
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent(
			'coding.thread.finished',
			'u1',
			{ conversationId: conv.id, status: 'completed' },
			db,
			runFn
		);
		expect(runFn).toHaveBeenCalledTimes(1);
		expect(runFn).toHaveBeenCalledWith(reviewer.id, 'u1', expect.any(String));
	});
});
