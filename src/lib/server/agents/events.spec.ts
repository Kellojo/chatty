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

describe('memory cleanup waits for extraction', () => {
	function seedBuiltins() {
		const extraction = createAgent(db, null, {
			name: 'memory-extraction',
			systemPrompt: 'x',
			triggerType: 'event',
			triggerConfig: { event: 'chat.created' }
		});
		const cleanup = createAgent(db, null, {
			name: 'memory-cleanup',
			systemPrompt: 'x',
			triggerType: 'event',
			triggerConfig: { event: 'memory.changed' }
		});
		return { extraction, cleanup };
	}

	it("queues cleanup while the user's extraction runs and starts it once that ends", async () => {
		const { extraction, cleanup } = seedBuiltins();
		const run = createAgentRun(db, { agentId: extraction.id, userId: 'u1', trigger: 'manual' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', { path: 'a.md' }, db, runFn);
		await emitAgentEvent('memory.changed', 'u1', { path: 'b.md' }, db, runFn);
		expect(runFn).not.toHaveBeenCalled();

		finishAgentRun(db, run.id, 'success');
		handleServerEvent(
			'u1',
			{ type: 'agent.run.finished', agentId: extraction.id, runId: run.id, status: 'success' },
			db,
			runFn
		);
		expect(runFn).toHaveBeenCalledTimes(1);
		expect(runFn).toHaveBeenCalledWith(cleanup.id, 'u1', expect.stringContaining('b.md'));
	});

	it("doesn't hold up cleanup for another user", async () => {
		const { extraction, cleanup } = seedBuiltins();
		createAgentRun(db, { agentId: extraction.id, userId: 'u1', trigger: 'manual' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u2', { path: 'a.md' }, db, runFn);
		expect(runFn).toHaveBeenCalledWith(cleanup.id, 'u2', expect.any(String));
	});

	it('only applies to the built-in agents', async () => {
		const extraction = createAgent(db, null, {
			name: 'memory-extraction',
			systemPrompt: 'x',
			triggerType: 'event',
			triggerConfig: { event: 'chat.created' }
		});
		const mine = createAgent(db, 'u1', {
			name: 'memory-cleanup',
			systemPrompt: 'x',
			triggerType: 'event',
			triggerConfig: { event: 'memory.changed' }
		});
		createAgentRun(db, { agentId: extraction.id, userId: 'u1', trigger: 'manual' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', {}, db, runFn);
		expect(runFn).toHaveBeenCalledWith(mine.id, 'u1', expect.any(String));
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

describe('event self-trigger guards', () => {
	it("ignores events caused by the same agent's own run", async () => {
		const agent = seedEventAgent('u1', { event: 'memory.changed' });
		const other = seedEventAgent('u1', { event: 'chat.created' });
		const own = createAgentRun(db, { agentId: agent.id, userId: 'u1', trigger: 'event' });
		const foreign = createAgentRun(db, { agentId: other.id, userId: 'u1', trigger: 'event' });
		finishAgentRun(db, own.id, 'success');
		finishAgentRun(db, foreign.id, 'success');
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', { agentRunId: own.id }, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
		await emitAgentEvent('memory.changed', 'u1', { agentRunId: foreign.id }, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
	});

	it('caps triggers of one agent per minute', async () => {
		seedEventAgent('u1', { event: 'memory.changed' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		for (let i = 0; i < 15; i++) {
			await emitAgentEvent('memory.changed', 'u1', { i }, db, runFn);
			// Let each run settle so the next event dispatches instead of queueing.
			await new Promise((r) => setTimeout(r, 0));
		}
		expect(runFn).toHaveBeenCalledTimes(10);
	});
});

describe('agent run conversations', () => {
	it('ignores events from chats Chatty dispatched for agent runs, replies included', async () => {
		seedEventAgent('u1', { event: 'chat.message_completed' });
		const dispatched = createConversation(db, 'u1', { origin: 'dispatch' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent(
			'chat.message_completed',
			'u1',
			{ conversationId: dispatched.id },
			db,
			runFn
		);
		expect(runFn).not.toHaveBeenCalled();
	});

	it('ignores events from hidden agent-run transcripts', async () => {
		seedEventAgent('u1', { event: 'chat.message_completed' });
		const hidden = createConversation(db, 'u1', { kind: 'agent-run' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('chat.message_completed', 'u1', { conversationId: hidden.id }, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
	});

	it("still reacts to the user's own chats", async () => {
		seedEventAgent('u1', { event: 'chat.message_completed' });
		const chat = createConversation(db, 'u1');
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('chat.message_completed', 'u1', { conversationId: chat.id }, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
	});
});

describe('private conversations', () => {
	const makePrivate = (table: 'agents' | 'conversations', id: string) =>
		db.prepare(`UPDATE ${table} SET private = 1 WHERE id = ?`).run(id);

	it('only reach private agents', async () => {
		const publicAgent = seedEventAgent('u1', { event: 'chat.message_completed' });
		const privateAgent = seedEventAgent('u1', { event: 'chat.message_completed' });
		makePrivate('agents', privateAgent.id);
		const chat = createConversation(db, 'u1', { private: true });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('chat.message_completed', 'u1', { conversationId: chat.id }, db, runFn);
		expect(runFn.mock.calls.map((c) => c[0])).toEqual([privateAgent.id]);
		expect(publicAgent.id).not.toBe(privateAgent.id);
	});

	it("treat a private agent run's events as private", async () => {
		const publicAgent = seedEventAgent('u1', { event: 'memory.changed' });
		const runner = createAgent(db, 'u1', {
			name: 'private runner',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		makePrivate('agents', runner.id);
		const run = createAgentRun(db, { agentId: runner.id, userId: 'u1', trigger: 'manual' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		await emitAgentEvent('memory.changed', 'u1', { path: 'a.md', agentRunId: run.id }, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
		await emitAgentEvent('memory.changed', 'u1', { path: 'b.md' }, db, runFn);
		expect(runFn).toHaveBeenCalledWith(publicAgent.id, 'u1', expect.any(String));
	});

	it("keep a private note's path from public agents", async () => {
		const publicAgent = seedEventAgent('u1', { event: 'memory.changed' });
		const privateAgent = seedEventAgent('u1', { event: 'memory.changed' });
		makePrivate('agents', privateAgent.id);
		const runFn = vi.fn().mockResolvedValue(undefined);
		const SECRET = 'people/alice-diagnosis.md';
		handleServerEvent(
			'u1',
			{
				type: 'memory.changed',
				scope: 'user',
				path: SECRET,
				action: 'update',
				author: 'user:u1',
				private: true
			},
			db,
			runFn
		);
		await vi.waitFor(() => expect(runFn).toHaveBeenCalledTimes(1));
		expect(runFn).toHaveBeenCalledWith(privateAgent.id, 'u1', expect.stringContaining(SECRET));
		expect(publicAgent.id).not.toBe(privateAgent.id);
	});

	it('give built-in memory agents a private note change without its path or run', async () => {
		const cleanup = createAgent(db, null, {
			name: 'memory-cleanup',
			systemPrompt: 'x',
			triggerType: 'event',
			triggerConfig: { event: 'memory.changed', every: 2 }
		});
		const runner = createAgent(db, 'u1', { name: 'r', systemPrompt: 'x', triggerType: 'manual' });
		const run = createAgentRun(db, { agentId: runner.id, userId: 'u1', trigger: 'manual' });
		const runFn = vi.fn().mockResolvedValue(undefined);
		const payload = {
			scope: 'user',
			path: 'people/alice-diagnosis.md',
			action: 'update',
			author: 'agent:x',
			agentRunId: run.id,
			private: true
		};
		await emitAgentEvent('memory.changed', 'u1', payload, db, runFn);
		expect(runFn).not.toHaveBeenCalled();
		// It still counts toward "every Nth change".
		await emitAgentEvent('memory.changed', 'u1', payload, db, runFn);
		expect(runFn).toHaveBeenCalledTimes(1);
		const [agentId, , instructions] = runFn.mock.calls[0];
		expect(agentId).toBe(cleanup.id);
		expect(instructions).not.toContain('alice');
		expect(instructions).not.toContain(run.id);
		expect(instructions).toContain('{"scope":"user","action":"update","private":true}');
	});

	it('pins chat event payloads to ids: no titles or content reach the agent', async () => {
		const SECRET = 'SECRET-TITLE-41b2';
		seedEventAgent('u1', { event: 'chat.created' });
		seedEventAgent('u1', { event: 'chat.message_completed' });
		const chat = createConversation(db, 'u1', { title: SECRET });
		const runFn = vi.fn().mockResolvedValue(undefined);
		handleServerEvent('u1', { type: 'chat.created', conversationId: chat.id }, db, runFn);
		handleServerEvent('u1', { type: 'chat.message_completed', conversationId: chat.id }, db, runFn);
		await vi.waitFor(() => expect(runFn).toHaveBeenCalledTimes(2));
		for (const [, , instructions] of runFn.mock.calls as [string, string, string][]) {
			expect(instructions).not.toContain(SECRET);
			const payload = JSON.parse(instructions.match(/Payload: (\{.*?\})\./)![1]);
			expect(Object.keys(payload)).toEqual(['conversationId']);
		}
	});
});
