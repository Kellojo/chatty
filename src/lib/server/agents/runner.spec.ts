import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCanAsk, ServerEvent } from '$lib/types.js';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspaces-'));

let behavior: 'ok' | 'fail' | 'hang' | 'ask' = 'ok';
/** Tool names offered to the model on each call. */
const offeredTools: string[][] = [];
/** System prompt of each call. */
const systemPrompts: string[] = [];

vi.mock('../llm/registry.js', async () => {
	const { MockLanguageModelV3 } = await import('ai/test');
	const { simulateReadableStream } = await import('ai');
	const model = new MockLanguageModelV3({
		doStream: async (options) => {
			offeredTools.push((options.tools ?? []).map((t) => t.name));
			const system = options.prompt.find((m) => m.role === 'system');
			systemPrompts.push(system && typeof system.content === 'string' ? system.content : '');
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
			if (behavior === 'ask') {
				return {
					stream: simulateReadableStream({
						chunks: [
							{
								type: 'tool-call',
								toolCallId: 'call-1',
								toolName: 'ask_user',
								input: JSON.stringify({ question: 'Archive 14 newsletters?', kind: 'confirm' })
							},
							{
								type: 'finish',
								finishReason: 'tool-calls',
								usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
							} as never
						]
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
	buildTools: async () => ({
		tools: {},
		toolToServer: {},
		deferred: new Set(),
		close: async () => undefined
	})
}));

const { getDb, closeDb } = await import('../db/index.js');
const { startAgentRun, stopAgentRun, stopAllAgentRuns } = await import('./runner.js');
const { createAgentRun, getAgentRun } = await import('../db/repo/agent-runs.js');
const { createAgent, getAgent, setAgentRunTimes } = await import('../db/repo/agents.js');
const { getConversation } = await import('../db/repo/conversations.js');
const { listMessages } = await import('../db/repo/messages.js');
const { createProvider } = await import('../db/repo/providers.js');
const { createModel } = await import('../db/repo/models.js');
const { subscribeAllServerEvents } = await import('../events/bus.js');
const { runChatTurnHeadless } = await import('../chat/service.js');
const { agentWorkspaceName } = await import('../workspaces.js');

type Db = ReturnType<typeof getDb>;

function seed(db: Db, canAsk: AgentCanAsk = 'never') {
	db.prepare(
		"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
	).run();
	createProvider(db, { name: 'P', type: 'openai-compatible' });
	db.prepare("UPDATE providers SET id = 'p1'").run();
	createModel(db, { providerId: 'p1', modelId: 'm1' });
	return createAgent(db, 'u1', {
		name: 'tester',
		systemPrompt: 'You test.',
		providerId: 'p1',
		modelId: 'm1',
		triggerType: 'manual',
		canAsk
	});
}

function recordEvents(): { events: ServerEvent[]; stop: () => void } {
	const events: ServerEvent[] = [];
	const stop = subscribeAllServerEvents((_userId, event) => events.push(event));
	return { events, stop };
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
		expect(conversation.origin).toBe('user');
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

		// The cost is the run's.
		const proxyRows = db
			.prepare('SELECT source, run_id FROM proxy_requests WHERE conversation_id = ?')
			.all(conversation.id) as { source: string; run_id: string }[];
		expect(proxyRows.length).toBeGreaterThan(0);
		expect(proxyRows.every((r) => r.source === 'agent' && r.run_id === run.id)).toBe(true);
		closeDb();
	});

	it('gives a hidden run the agent prompt and run header, without widgets or chat events', async () => {
		behavior = 'ok';
		const db = getDb();
		const agent = seed(db);
		const { events, stop } = recordEvents();
		try {
			const { done } = await startAgentRun({ agentId: agent.id, trigger: 'manual', userId: 'u1' });
			await done;
		} finally {
			stop();
		}
		const system = systemPrompts.at(-1)!;
		expect(system).toContain('You test.');
		expect(system).toContain('You are running autonomously as the agent "tester"');
		expect(system).toContain('Do not ask the user questions');
		expect(system).not.toMatch(/widget/i);
		expect(offeredTools.at(-1)).not.toContain('ask_user');
		expect(events.some((e) => e.type.startsWith('chat.'))).toBe(false);
		expect(events.map((e) => e.type)).toContain('agent.run.progress');
		closeDb();
	});

	it('dispatches an agent that may ask as a visible chat, settled once it succeeds', async () => {
		behavior = 'ok';
		const db = getDb();
		const agent = seed(db, 'any');
		const { events, stop } = recordEvents();
		let finished: Awaited<ReturnType<typeof startAgentRun>>['run'];
		try {
			const { done } = await startAgentRun({ agentId: agent.id, trigger: 'manual', userId: 'u1' });
			finished = await done;
		} finally {
			stop();
		}
		expect(finished.status).toBe('success');
		const conversation = getConversation(db, 'u1', finished.conversation_id!)!;
		expect(conversation.kind).toBe('chat');
		expect(conversation.origin).toBe('dispatch');
		expect(conversation.system_prompt).toBe('You test.');
		// A routine success needs no attention.
		expect(conversation.settled_at).not.toBeNull();
		expect(offeredTools.at(-1)).toContain('ask_user');
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'chat.message_completed', agentRunId: finished.id })
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'agent.run.finished',
				status: 'success',
				conversationId: conversation.id,
				visible: true
			})
		);
		closeDb();
	});

	it('waits for the answer to an ask_user question, and a reply resumes the run', async () => {
		behavior = 'ask';
		const db = getDb();
		const agent = seed(db, 'any');
		const { events, stop } = recordEvents();
		try {
			const { run, done } = await startAgentRun({
				agentId: agent.id,
				trigger: 'manual',
				userId: 'u1'
			});
			const waiting = await done;
			expect(waiting.status).toBe('awaiting_input');
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'agent.run.awaiting_input',
					runId: run.id,
					question: 'Archive 14 newsletters?'
				})
			);
			const conversation = getConversation(db, 'u1', waiting.conversation_id!)!;
			expect(conversation.settled_at).toBeNull();

			// Another run of the agent meanwhile works without asking.
			behavior = 'ok';
			const second = await startAgentRun({ agentId: agent.id, trigger: 'manual', userId: 'u1' });
			await second.done;
			expect(offeredTools.at(-1)).not.toContain('ask_user');

			// The user's reply continues the run, and the model sees the question answered.
			const outcome = await runChatTurnHeadless('u1', conversation, {
				message: { id: 'reply-1', role: 'user', parts: [{ type: 'text', text: 'Yes' }] }
			});
			expect(outcome.status).toBe('complete');
			expect(getAgentRun(db, run.id)!.status).toBe('success');
			const runRows = db
				.prepare("SELECT run_id FROM proxy_requests WHERE conversation_id = ? AND source = 'agent'")
				.all(conversation.id) as { run_id: string }[];
			expect(runRows.length).toBeGreaterThanOrEqual(2);
			expect(runRows.every((r) => r.run_id === run.id)).toBe(true);
			expect(systemPrompts.at(-1)).toContain('The user has replied to your question');
		} finally {
			stop();
			behavior = 'ok';
		}
		closeDb();
	});

	it("gives memory extraction the exact start of the user's last successful run", async () => {
		behavior = 'ok';
		const db = getDb();
		seed(db);
		db.prepare(
			`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u2', 'B', 'b@c.d', 0, 0, 0, 'user')`
		).run();
		const agent = createAgent(db, null, {
			name: 'memory-extraction',
			systemPrompt: 'You distill.',
			providerId: 'p1',
			modelId: 'm1',
			triggerType: 'schedule',
			triggerConfig: { cron: '0 3 * * *' }
		});
		const u1Started = Date.parse('2026-01-02T03:04:05.000Z');
		const prior = createAgentRun(db, { agentId: agent.id, userId: 'u1', trigger: 'schedule' });
		db.prepare(
			"UPDATE agent_runs SET status = 'success', started_at = ?, ended_at = ? WHERE id = ?"
		).run(u1Started, u1Started + 60_000, prior.id);
		// A later failed run, and another user's run, don't move u1's window.
		const failed = createAgentRun(db, { agentId: agent.id, userId: 'u1', trigger: 'schedule' });
		db.prepare("UPDATE agent_runs SET status = 'failed', started_at = ? WHERE id = ?").run(
			Date.parse('2026-03-01T00:00:00.000Z'),
			failed.id
		);
		setAgentRunTimes(db, agent.id, { lastRunAt: Date.parse('2026-06-01T00:00:00.000Z') });

		const { done } = await startAgentRun({ agentId: agent.id, trigger: 'schedule', userId: 'u1' });
		const finished = await done;
		const [userMessage] = listMessages(db, finished.conversation_id!);
		expect(userMessage.parts).toContain('since = \\"2026-01-02T03:04:05.000Z\\"');
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
		behavior = 'ok';
		closeDb();
	});

	it('fails the run instead of leaving it running when setup throws', async () => {
		const db = getDb();
		const agent = seed(db);
		db.prepare("UPDATE agents SET skill_names = 'not json' WHERE id = ?").run(agent.id);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const { done } = await startAgentRun({ agentId: agent.id, trigger: 'manual', userId: 'u1' });
			await done;
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
		getDb();
		expect(stopAgentRun('no-such-run')).toBe(false);
		closeDb();
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

		// The turn starts asynchronously; wait until it streams.
		await vi.waitFor(() => expect(stopAgentRun(run.id)).toBe(true));
		const finished = await done;
		expect(finished.status).toBe('failed');
		expect(finished.error).toBe('Stopped by user');
		expect(finished.ended_at).not.toBeNull();

		expect(stopAgentRun(run.id)).toBe(false);
		behavior = 'ok';
		closeDb();
	});

	it('dismisses the question of a run waiting for an answer', async () => {
		behavior = 'ask';
		const db = getDb();
		const agent = seed(db, 'any');
		const { run, done } = await startAgentRun({
			agentId: agent.id,
			trigger: 'manual',
			userId: 'u1'
		});
		expect((await done).status).toBe('awaiting_input');

		expect(stopAgentRun(run.id)).toBe(true);
		expect(getAgentRun(db, run.id)!.status).toBe('dismissed');
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
		const promptsBefore = systemPrompts.length;

		const { run, done } = await startAgentRun(input);
		// Let the turn reach its stream before shutting down.
		await vi.waitFor(() => expect(systemPrompts.length).toBeGreaterThan(promptsBefore));
		await stopAllAgentRuns(5000);

		await expect(done).resolves.toMatchObject({ status: 'failed' });
		const finished = getAgentRun(db, run.id)!;
		expect(finished.status).toBe('failed');
		expect(finished.error).toBe('Interrupted by server shutdown');

		const messages = listMessages(db, finished.conversation_id!);
		expect(messages.map((m) => m.status)).not.toContain('partial');

		await expect(startAgentRun(input)).rejects.toThrow('shutting down');
		behavior = 'ok';
		closeDb();
	});
});
