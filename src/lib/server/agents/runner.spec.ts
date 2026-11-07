import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspaces-'));

let behavior: 'ok' | 'fail' | 'hang' = 'ok';

vi.mock('../llm/registry.js', async () => {
	const { MockLanguageModelV3 } = await import('ai/test');
	const { simulateReadableStream } = await import('ai');
	const model = new MockLanguageModelV3({
		doStream: async (options) => {
			if (behavior === 'fail') throw new Error('model exploded');
			if (behavior === 'hang') {
				return {
					stream: new ReadableStream({
						start(streamController) {
							const signal = options.abortSignal;
							const onAbort = () => streamController.error(signal?.reason ?? new Error('aborted'));
							if (signal?.aborted) {
								onAbort();
								return;
							}
							signal?.addEventListener('abort', onAbort);
						}
					})
				};
			}
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: 'text-start', id: 't1' },
						{ type: 'text-delta', id: 't1', delta: 'Agent ' },
						{ type: 'text-delta', id: 't1', delta: 'done' },
						{ type: 'text-end', id: 't1' },
						{
							type: 'finish',
							finishReason: 'stop',
							usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
						} as never
					]
				})
			};
		}
	});
	return {
		resolveModel: () => model,
		ModelUnavailableError: class ModelUnavailableError extends Error {}
	};
});

vi.mock('../tools/registry.js', () => ({
	buildTools: async () => ({ tools: {}, toolToServer: {}, close: async () => undefined })
}));

const { getDb, closeDb } = await import('../db/index.js');
const { startAgentRun, stopAgentRun, stopAllAgentRuns } = await import('./runner.js');
const { getAgentRun } = await import('../db/repo/agent-runs.js');
const { createAgent, getAgent } = await import('../db/repo/agents.js');
const { getConversation } = await import('../db/repo/conversations.js');
const { listMessages } = await import('../db/repo/messages.js');
const { agentWorkspaceName } = await import('../workspaces.js');

type Db = ReturnType<typeof getDb>;

function seed(db: Db) {
	db.prepare(
		"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
	).run();
	return createAgent(db, 'u1', {
		name: 'tester',
		systemPrompt: 'You test.',
		providerId: 'p1',
		modelId: 'm1',
		triggerType: 'manual'
	});
}

describe('startAgentRun', () => {
	it('runs an agent to success and persists everything', async () => {
		behavior = 'ok';
		const db = getDb();
		const agent = seed(db);

		const { run, done } = await startAgentRun({
			agentId: agent.id,
			trigger: 'manual',
			userId: 'u1'
		});
		expect(run.status).toBe('running');
		const finished = await done;
		expect(finished.status).toBe('success');
		expect(finished.ended_at).not.toBeNull();

		const conversation = getConversation(db, 'u1', finished.conversation_id!)!;
		expect(conversation.kind).toBe('agent-run');
		expect(conversation.mode).toBe('agent');
		expect(conversation.agent_id).toBe(agent.id);

		const messages = listMessages(db, conversation.id);
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe('user');
		expect(messages[0].status).toBe('complete');
		const assistant = messages.find((m) => m.role === 'assistant')!;
		expect(assistant.status).toBe('complete');
		expect(JSON.parse(assistant.parts)).toContainEqual(
			expect.objectContaining({ type: 'text', text: 'Agent done' })
		);

		expect(getAgent(db, agent.id)!.last_run_at).not.toBeNull();
		expect(
			fs.existsSync(path.join(process.env.WORKSPACES_VOLUME!, agentWorkspaceName(agent.id, run.id)))
		).toBe(true);
		closeDb();
	});

	it('marks the run failed when the model errors', async () => {
		behavior = 'fail';
		const db = getDb();
		const agent = seed(db);

		const { done } = await startAgentRun({
			agentId: agent.id,
			trigger: 'http',
			userId: 'u1'
		});
		const finished = await done;
		expect(finished.status).toBe('failed');
		expect(finished.error).toBeTruthy();
		expect(finished.ended_at).not.toBeNull();

		const assistant = listMessages(db, finished.conversation_id!).find(
			(m) => m.role === 'assistant'
		);
		if (assistant) {
			expect(assistant.status).toBe('failed');
			expect(assistant.error).toBeTruthy();
		}
		closeDb();
	});

	it('fails the run instead of leaving it running when setup throws', async () => {
		const db = getDb();
		const agent = seed(db);
		db.prepare("UPDATE agents SET skill_names = 'not json' WHERE id = ?").run(agent.id);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			await expect(
				startAgentRun({ agentId: agent.id, trigger: 'manual', userId: 'u1' })
			).rejects.toThrow();
			const runs = db
				.prepare('SELECT status, error FROM agent_runs WHERE agent_id = ?')
				.all(agent.id) as { status: string; error: string | null }[];
			expect(runs).toHaveLength(1);
			expect(runs[0].status).toBe('failed');
			expect(runs[0].error).toBeTruthy();
		} finally {
			consoleError.mockRestore();
			closeDb();
		}
	});

	it('throws when the agent does not exist', async () => {
		getDb();
		await expect(
			startAgentRun({ agentId: 'missing', trigger: 'manual', userId: 'u1' })
		).rejects.toThrow('Agent not found');
		closeDb();
	});
});

describe('stopAgentRun', () => {
	it('returns false for an unknown run id', () => {
		expect(stopAgentRun('no-such-run')).toBe(false);
	});

	it('aborts a running run and marks it failed with "Stopped by user"', async () => {
		behavior = 'hang';
		const db = getDb();
		const agent = seed(db);

		const { run, done } = await startAgentRun({
			agentId: agent.id,
			trigger: 'manual',
			userId: 'u1'
		});
		expect(run.status).toBe('running');

		expect(stopAgentRun(run.id)).toBe(true);
		const finished = await done;
		expect(finished.status).toBe('failed');
		expect(finished.error).toBe('Stopped by user');
		expect(finished.ended_at).not.toBeNull();

		expect(stopAgentRun(run.id)).toBe(false);
		behavior = 'ok';
		closeDb();
	});
});

// Keep last: shutting down permanently stops this module instance accepting runs.
describe('stopAllAgentRuns', () => {
	it('fails running runs with a shutdown reason, then refuses new ones', async () => {
		behavior = 'hang';
		const db = getDb();
		const agent = seed(db);
		const input = { agentId: agent.id, trigger: 'manual' as const, userId: 'u1' };

		const { run, done } = await startAgentRun(input);
		await stopAllAgentRuns(5000);

		const finished = getAgentRun(db, run.id)!;
		expect(finished.status).toBe('failed');
		expect(finished.error).toBe('Interrupted by server shutdown');
		await expect(done).resolves.toMatchObject({ status: 'failed' });

		const messages = listMessages(db, finished.conversation_id!);
		expect(messages.map((m) => m.status)).not.toContain('partial');

		await expect(startAgentRun(input)).rejects.toThrow('shutting down');
		behavior = 'ok';
		closeDb();
	});
});
