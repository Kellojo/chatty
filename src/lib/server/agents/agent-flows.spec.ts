// End-to-end flows of agent runs: dispatched chats that ask the user, hidden
// runs, settling, stopping, deleting, superseding, loop guards, jobs, restart
// and shutdown. Drives the real runner, chat engine and route handlers; only the
// model and the MCP tool registry are mocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '$lib/types.js';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flows-'));

type ModelStep =
	| { kind: 'text'; text?: string }
	| { kind: 'fail'; error?: unknown }
	| { kind: 'hang' }
	| { kind: 'ask'; input: Record<string, unknown>; gate?: Promise<void> };

interface ModelCall {
	tools: string[];
	system: string;
	prompt: unknown[];
}

const model = vi.hoisted(() => ({
	/** What the next model calls do, in order; a plain text reply once empty. */
	queue: [] as ModelStep[],
	calls: [] as ModelCall[]
}));

vi.mock('../llm/registry.js', async () => {
	const { MockLanguageModelV3 } = await import('ai/test');
	const { simulateReadableStream } = await import('ai');
	const usage = {
		inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
		outputTokens: { total: 2, text: 2, reasoning: undefined }
	};
	const mock = new MockLanguageModelV3({
		doStream: async (options) => {
			const system = options.prompt.find((m) => m.role === 'system');
			model.calls.push({
				tools: (options.tools ?? []).map((t) => t.name),
				system: system && typeof system.content === 'string' ? system.content : '',
				prompt: options.prompt as unknown[]
			});
			const step: ModelStep = model.queue.shift() ?? { kind: 'text' };
			if (step.kind === 'fail') throw step.error ?? new Error('model exploded');
			if (step.kind === 'hang') {
				return {
					stream: new ReadableStream({
						start(controller) {
							const signal = options.abortSignal;
							const onAbort = () => controller.error(signal?.reason ?? new Error('aborted'));
							if (signal?.aborted) return onAbort();
							signal?.addEventListener('abort', onAbort);
						}
					})
				};
			}
			if (step.kind === 'ask') {
				if (step.gate) await step.gate;
				return {
					stream: simulateReadableStream({
						chunks: [
							{
								type: 'tool-call',
								toolCallId: `ask-${model.calls.length}`,
								toolName: 'ask_user',
								input: JSON.stringify(step.input)
							},
							{ type: 'finish', finishReason: 'tool-calls', usage }
						] as never[]
					})
				};
			}
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: 'text-start', id: 't1' },
						{ type: 'text-delta', id: 't1', delta: step.text ?? 'Agent done' },
						{ type: 'text-end', id: 't1' },
						{ type: 'finish', finishReason: 'stop', usage }
					] as never[]
				})
			};
		}
	});
	return {
		resolveModel: () => mock,
		roleModel: () => undefined,
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
const { SETTLED_DISMISS_REASON } = await import('./run-lifecycle.js');
const { handleServerEvent } = await import('./events.js');
const { failRunningAgentRuns, getAgentRun } = await import('../db/repo/agent-runs.js');
const { createAgent } = await import('../db/repo/agents.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { listMessages } = await import('../db/repo/messages.js');
const { createProvider } = await import('../db/repo/providers.js');
const { createModel } = await import('../db/repo/models.js');
const { subscribeAllServerEvents } = await import('../events/bus.js');
const { expireAgentQuestions, pruneAgentRunChats, runAutoSettle } = await import('../jobs.js');
const { DECIDE_YOURSELF_ANSWER } = await import('$lib/ask-user.js');
const chatRoute = await import('../../../routes/api/chat/+server.js');
const activeRoute = await import('../../../routes/api/chat/active/+server.js');
const settleRoute = await import('../../../routes/api/conversations/[id]/settle/+server.js');
const conversationRoute = await import('../../../routes/api/conversations/[id]/+server.js');
const stopRoute = await import('../../../routes/api/agent-runs/[id]/stop/+server.js');

type Db = ReturnType<typeof getDb>;
type AgentCanAsk = 'never' | 'approvals' | 'any';

const DAY_MS = 24 * 60 * 60 * 1000;

let db: Db;
let events: ServerEvent[];
let stopRecording: () => void;

beforeEach(() => {
	closeDb();
	db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
		 VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')`
	).run();
	createProvider(db, { name: 'P', type: 'openai-compatible' });
	db.prepare("UPDATE providers SET id = 'p1'").run();
	createModel(db, { providerId: 'p1', modelId: 'm1' });
	model.queue.length = 0;
	model.calls.length = 0;
	events = [];
	stopRecording = subscribeAllServerEvents((_userId, event) => events.push(event));
});

afterEach(() => {
	stopRecording();
	model.queue.length = 0;
});

function seedAgent(canAsk: AgentCanAsk = 'any', name = 'inbox') {
	return createAgent(db, 'u1', {
		name,
		systemPrompt: 'You tidy the inbox.',
		providerId: 'p1',
		modelId: 'm1',
		triggerType: 'manual',
		canAsk
	});
}

/** A chat the user started themselves (titled, so no title call hits the model). */
function seedUserChat() {
	const conversation = createConversation(db, 'u1', {
		providerId: 'p1',
		modelId: 'm1',
		mode: 'chat',
		title: 'Normal chat'
	});
	return conversation;
}

const confirmQuestion = { question: 'Archive 14 newsletters?', kind: 'confirm' };

async function dispatch(agentId: string) {
	return startAgentRun({ agentId, trigger: 'manual', userId: 'u1' });
}

/** A dispatched run that ends waiting on its question. */
async function awaitingRun(agentId: string, input: Record<string, unknown> = confirmQuestion) {
	model.queue.push({ kind: 'ask', input });
	const { run, done } = await dispatch(agentId);
	const waiting = await done;
	expect(waiting.status).toBe('awaiting_input');
	return { run, conversationId: waiting.conversation_id! };
}

interface RouteResult {
	status: number;
	res: Response | null;
	body: unknown;
}

async function callRoute(
	handler: (event: never) => Response | Promise<Response>,
	init: { method: string; params?: Record<string, string>; body?: unknown }
): Promise<RouteResult> {
	const url = new URL('http://localhost/api/test');
	const event = {
		locals: { user: { id: 'u1', role: 'user' }, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, {
			method: init.method,
			headers: { 'content-type': 'application/json' },
			body: init.body === undefined ? undefined : JSON.stringify(init.body)
		}),
		url
	};
	try {
		const res = await handler(event as never);
		return { status: res.status, res, body: null };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, res: null, body: e.body };
		throw e;
	}
}

/** POST /api/chat, draining the streamed reply as the client would. */
async function postChat(body: Record<string, unknown>): Promise<string> {
	const result = await callRoute(chatRoute.POST as never, { method: 'POST', body });
	expect(result.status).toBe(200);
	return await result.res!.text();
}

function reply(conversationId: string, text: string, id = `reply-${Math.random()}`) {
	return postChat({
		conversationId,
		message: { id, role: 'user', parts: [{ type: 'text', text }] }
	});
}

async function runSettles(runId: string, status: string) {
	await vi.waitFor(() => expect(getAgentRun(db, runId)!.status).toBe(status));
	return getAgentRun(db, runId)!;
}

function conversationOf(id: string) {
	return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as {
		kind: string;
		origin: string;
		settled_at: number | null;
		settled_reason: string | null;
		deleted_at: number | null;
	};
}

/** The answer the model was shown for its ask_user call, from a call's prompt. */
function askUserAnswerIn(call: ModelCall): string | null {
	for (const message of call.prompt as { role: string; content: unknown }[]) {
		if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
		for (const part of message.content as {
			type: string;
			toolName?: string;
			output?: { type: string; value?: unknown };
		}[]) {
			if (part.type !== 'tool-result' || part.toolName !== 'ask_user') continue;
			const value = part.output?.value as { answer?: string } | undefined;
			if (value?.answer !== undefined) return value.answer;
		}
	}
	return null;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('dispatch â†’ ask â†’ answer', () => {
	it('resumes the run with the answer, bills it to the run and keeps the chat active', async () => {
		const agent = seedAgent('any');
		const { run, conversationId } = await awaitingRun(agent.id);
		const conversation = conversationOf(conversationId);
		expect(conversation.kind).toBe('chat');
		expect(conversation.origin).toBe('dispatch');
		expect(conversation.settled_at).toBeNull();
		expect(model.calls[0].tools).toContain('ask_user');
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'agent.run.awaiting_input',
				runId: run.id,
				question: 'Archive 14 newsletters?'
			})
		);

		model.queue.push({ kind: 'text', text: 'Archived them.' });
		const body = await reply(conversationId, 'Approved');
		expect(body).toContain('Archived them.');
		const finished = await runSettles(run.id, 'success');
		expect(finished.error).toBeNull();

		// The resumed turn: the question is answered by the reply, and the header says so.
		const resumedCall = model.calls.at(-1)!;
		expect(askUserAnswerIn(resumedCall)).toBe('Approved');
		expect(resumedCall.system).toContain('The user has replied to your question');
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'agent.run.started', runId: run.id, conversationId })
		);

		// Both turns are the run's cost.
		const rows = db
			.prepare('SELECT source, run_id FROM proxy_requests WHERE conversation_id = ?')
			.all(conversationId) as { source: string; run_id: string | null }[];
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(rows.every((r) => r.source === 'agent' && r.run_id === run.id)).toBe(true);

		// The user took part: the chat stays where they are looking.
		expect(conversationOf(conversationId).settled_at).toBeNull();
	});

	it.each([
		['an option label', 'Archive all'],
		['free text', 'Only the ones older than a month, please'],
		['"Use your recommendation."', DECIDE_YOURSELF_ANSWER]
	])('accepts %s as the answer', async (_label, answer) => {
		const agent = seedAgent('any');
		const { run, conversationId } = await awaitingRun(agent.id, {
			question: 'What should I do with the newsletters?',
			kind: 'choice',
			options: [
				{ value: 'archive', label: 'Archive all' },
				{ value: 'keep', label: 'Keep them' }
			],
			recommended: 'archive'
		});
		await reply(conversationId, answer);
		await runSettles(run.id, 'success');
		expect(askUserAnswerIn(model.calls.at(-1)!)).toBe(answer);
		const messages = listMessages(db, conversationId);
		expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
		expect(messages.at(-1)!.status).toBe('complete');
	});
});

describe('routine and hidden runs', () => {
	it('auto-settles a routine dispatched success', async () => {
		const agent = seedAgent('approvals');
		const { done } = await dispatch(agent.id);
		const finished = await done;
		expect(finished.status).toBe('success');
		const conversation = conversationOf(finished.conversation_id!);
		expect(conversation.settled_at).not.toBeNull();
		expect(conversation.settled_reason).toBe('auto');
		expect(model.calls[0].system).toContain('irreversible or risky');
	});

	it('keeps hidden runs out of chat events and the active-streams list', async () => {
		const hidden = seedAgent('never', 'hidden');
		const visible = seedAgent('any', 'visible');

		model.queue.push({ kind: 'hang' }, { kind: 'hang' });
		const hiddenRun = await dispatch(hidden.id);
		const visibleRun = await dispatch(visible.id);
		await vi.waitFor(() => expect(model.calls).toHaveLength(2));

		const active = await callRoute(activeRoute.GET as never, { method: 'GET' });
		const { conversationIds } = (await active.res!.json()) as { conversationIds: string[] };
		expect(conversationIds).toContain(visibleRun.run.conversation_id);
		expect(conversationIds).not.toContain(hiddenRun.run.conversation_id);

		expect(stopAgentRun(hiddenRun.run.id)).toBe(true);
		expect(stopAgentRun(visibleRun.run.id)).toBe(true);
		await hiddenRun.done;
		await visibleRun.done;

		expect(conversationOf(hiddenRun.run.conversation_id!).kind).toBe('agent-run');
		const hiddenChatEvents = events.filter(
			(e) =>
				e.type.startsWith('chat.') &&
				(e as { conversationId?: string }).conversationId === hiddenRun.run.conversation_id
		);
		expect(hiddenChatEvents).toEqual([]);
		expect(
			events.some(
				(e) =>
					e.type === 'chat.stream.started' && e.conversationId === visibleRun.run.conversation_id
			)
		).toBe(true);
	});
});

describe('one open question per agent', () => {
	it('withholds ask_user from other runs until the open question is answered', async () => {
		const agent = seedAgent('any');
		const first = await awaitingRun(agent.id);

		const second = await dispatch(agent.id);
		expect((await second.done).status).toBe('success');
		expect(model.calls.at(-1)!.tools).not.toContain('ask_user');
		expect(model.calls.at(-1)!.system).toContain('Do not ask the user questions');

		await reply(first.conversationId, 'Approved');
		await runSettles(first.run.id, 'success');

		const third = await dispatch(agent.id);
		await third.done;
		expect(model.calls.at(-1)!.tools).toContain('ask_user');
	});
});

describe('settling a dispatched chat', () => {
	it('dismisses on settle, restores on unsettle, and a reply after settling resumes the run', async () => {
		const agent = seedAgent('any');
		const { run, conversationId } = await awaitingRun(agent.id);
		const params = { id: conversationId };

		expect((await callRoute(settleRoute.POST as never, { method: 'POST', params })).status).toBe(
			200
		);
		expect(getAgentRun(db, run.id)).toMatchObject({
			status: 'dismissed',
			error: SETTLED_DISMISS_REASON
		});

		expect(
			(await callRoute(settleRoute.DELETE as never, { method: 'DELETE', params })).status
		).toBe(200);
		expect(getAgentRun(db, run.id)).toMatchObject({ status: 'awaiting_input', error: null });

		await callRoute(settleRoute.POST as never, { method: 'POST', params });
		expect(getAgentRun(db, run.id)!.status).toBe('dismissed');

		await reply(conversationId, 'Approved');
		await runSettles(run.id, 'success');
		expect(askUserAnswerIn(model.calls.at(-1)!)).toBe('Approved');
		expect(model.calls.at(-1)!.system).toContain('The user has replied to your question');
		expect(conversationOf(conversationId).settled_at).toBeNull();
	});
});

describe('stopping via the route', () => {
	it('fails a running run with "Stopped by user"', async () => {
		const agent = seedAgent('any');
		model.queue.push({ kind: 'hang' });
		const { run, done } = await dispatch(agent.id);
		await vi.waitFor(() => expect(model.calls).toHaveLength(1));

		const res = await callRoute(stopRoute.POST as never, {
			method: 'POST',
			params: { id: run.id }
		});
		expect(res.status).toBe(200);
		expect(await done).toMatchObject({ status: 'failed', error: 'Stopped by user' });
	});

	it('dismisses the question of an awaiting run', async () => {
		const agent = seedAgent('any');
		const { run } = await awaitingRun(agent.id);
		const res = await callRoute(stopRoute.POST as never, {
			method: 'POST',
			params: { id: run.id }
		});
		expect(res.status).toBe(200);
		expect(getAgentRun(db, run.id)).toMatchObject({
			status: 'dismissed',
			error: 'Dismissed by user'
		});
		// Nothing left to stop.
		const again = await callRoute(stopRoute.POST as never, {
			method: 'POST',
			params: { id: run.id }
		});
		expect(again.status).toBe(409);
	});
});

describe('deleting a dispatched chat', () => {
	it('dismisses the question of an awaiting run', async () => {
		const agent = seedAgent('any');
		const { run, conversationId } = await awaitingRun(agent.id);
		const res = await callRoute(conversationRoute.DELETE as never, {
			method: 'DELETE',
			params: { id: conversationId }
		});
		expect(res.status).toBe(200);
		expect(getAgentRun(db, run.id)).toMatchObject({
			status: 'dismissed',
			error: 'Dismissed: chat deleted'
		});
	});

	it('dismisses a question asked after the chat was deleted mid-turn', async () => {
		const agent = seedAgent('any');
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		model.queue.push({ kind: 'ask', input: confirmQuestion, gate });
		const { run, done } = await dispatch(agent.id);
		await vi.waitFor(() => expect(model.calls).toHaveLength(1));

		const res = await callRoute(conversationRoute.DELETE as never, {
			method: 'DELETE',
			params: { id: run.conversation_id! }
		});
		expect(res.status).toBe(200);
		open();

		expect(await done).toMatchObject({ status: 'dismissed', error: 'Dismissed: chat deleted' });
		expect(events.some((e) => e.type === 'agent.run.awaiting_input')).toBe(false);
		expect(conversationOf(run.conversation_id!).deleted_at).not.toBeNull();
	});
});

describe('the user typing while a run streams', () => {
	it('supersedes the run turn and answers the user as an ordinary chat turn', async () => {
		const agent = seedAgent('any');
		model.queue.push({ kind: 'hang' });
		const { run, done } = await dispatch(agent.id);
		await vi.waitFor(() => expect(model.calls).toHaveLength(1));
		const conversationId = run.conversation_id!;

		model.queue.push({ kind: 'text', text: 'Hello there' });
		const body = await reply(conversationId, 'Actually, wait', 'user-interrupt');
		expect(body).toContain('Hello there');

		expect(await done).toMatchObject({ status: 'failed', error: 'Superseded by your message' });
		// The user's turn is not the run's: no run header, billed as chat.
		expect(model.calls.at(-1)!.system).not.toContain('You are running autonomously');
		const messages = listMessages(db, conversationId);
		const last = messages.at(-1)!;
		expect(last.role).toBe('assistant');
		expect(last.status).toBe('complete');
		const rows = db
			.prepare('SELECT source, run_id FROM proxy_requests WHERE message_id = ?')
			.all(last.id) as { source: string; run_id: string | null }[];
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.source === 'chat' && r.run_id === null)).toBe(true);
		expect(getAgentRun(db, run.id)!.status).toBe('failed');
		await vi.waitFor(() =>
			expect(events).toContainEqual({ type: 'chat.message_completed', conversationId })
		);
	});
});

describe('failing runs', () => {
	it('fails with a readable error and keeps only the latest failure active', async () => {
		const agent = seedAgent('any');
		model.queue.push({ kind: 'fail', error: { message: 'Rate limit reached', code: 429 } });
		const first = await (await dispatch(agent.id)).done;
		expect(first.status).toBe('failed');
		expect(first.error).toBe('Rate limit reached');
		expect(conversationOf(first.conversation_id!).settled_at).toBeNull();

		model.queue.push({ kind: 'fail', error: new Error('model exploded') });
		const second = await (await dispatch(agent.id)).done;
		expect(second).toMatchObject({ status: 'failed', error: 'model exploded' });
		expect(conversationOf(first.conversation_id!).settled_at).not.toBeNull();
		expect(conversationOf(second.conversation_id!).settled_at).toBeNull();

		// A later success tidies the remaining failure away as well.
		const third = await (await dispatch(agent.id)).done;
		expect(third.status).toBe('success');
		expect(conversationOf(second.conversation_id!).settled_at).not.toBeNull();
	});
});

describe('event loop guard', () => {
	it('does not trigger chat.message_completed agents from dispatched chats', async () => {
		const runFn = vi.fn(async () => undefined);
		const stop = subscribeAllServerEvents((userId, event) =>
			handleServerEvent(userId, event, db, runFn)
		);
		try {
			createAgent(db, 'u1', {
				name: 'listener',
				systemPrompt: 'x',
				providerId: 'p1',
				modelId: 'm1',
				triggerType: 'event',
				triggerConfig: { event: 'chat.message_completed' },
				canAsk: 'never'
			});
			const agent = seedAgent('any');

			// A routine dispatched run completes a message...
			await (
				await dispatch(agent.id)
			).done;
			// ...and so does the user's reply in a dispatched chat.
			const { run, conversationId } = await awaitingRun(agent.id);
			await reply(conversationId, 'Approved');
			await runSettles(run.id, 'success');
			await tick();
			expect(
				events.filter((e) => e.type === 'chat.message_completed').length
			).toBeGreaterThanOrEqual(2);
			expect(runFn).not.toHaveBeenCalled();

			// A chat the user started does trigger it.
			const chat = seedUserChat();
			await reply(chat.id, 'hello');
			await vi.waitFor(() => expect(runFn).toHaveBeenCalledTimes(1));
			expect(runFn.mock.calls[0]).toEqual([
				expect.any(String),
				'u1',
				expect.stringContaining(chat.id)
			]);
		} finally {
			stop();
		}
	});
});

describe('jobs', () => {
	it('expireAgentQuestions dismisses questions older than the TTL only', async () => {
		const agent = seedAgent('any');
		const old = await awaitingRun(agent.id);
		db.prepare('UPDATE agent_runs SET ended_at = ?, started_at = ? WHERE id = ?').run(
			Date.now() - 8 * DAY_MS,
			Date.now() - 8 * DAY_MS,
			old.run.id
		);
		const other = seedAgent('any', 'other');
		const fresh = await awaitingRun(other.id);

		expect(expireAgentQuestions(db, 7)).toBe(1);
		expect(getAgentRun(db, old.run.id)).toMatchObject({
			status: 'dismissed',
			error: 'Dismissed: no answer within 7 days'
		});
		expect(getAgentRun(db, fresh.run.id)!.status).toBe('awaiting_input');
	});

	it('runAutoSettle never settles a chat waiting on an answer', async () => {
		const agent = seedAgent('any');
		const { conversationId } = await awaitingRun(agent.id);
		const idle = seedUserChat();
		const longAgo = Date.now() - 30 * DAY_MS;
		db.prepare(
			'UPDATE conversations SET created_at = ?, updated_at = ?, last_read_at = ? WHERE id IN (?, ?)'
		).run(longAgo, longAgo, longAgo, conversationId, idle.id);

		expect(runAutoSettle(db, 7)).toBe(1);
		expect(conversationOf(idle.id).settled_at).not.toBeNull();
		expect(conversationOf(conversationId).settled_at).toBeNull();
	});

	it('pruneAgentRunChats trashes old untouched run chats but keeps replied ones', async () => {
		const agent = seedAgent('any');
		const routine = await (await dispatch(agent.id)).done;
		expect(conversationOf(routine.conversation_id!).settled_at).not.toBeNull();

		const answered = await awaitingRun(agent.id);
		await reply(answered.conversationId, 'Approved');
		await runSettles(answered.run.id, 'success');
		await callRoute(settleRoute.POST as never, {
			method: 'POST',
			params: { id: answered.conversationId }
		});

		const longAgo = Date.now() - 40 * DAY_MS;
		db.prepare('UPDATE conversations SET settled_at = ? WHERE id IN (?, ?)').run(
			longAgo,
			routine.conversation_id,
			answered.conversationId
		);

		expect(pruneAgentRunChats(db, 30)).toBe(1);
		expect(conversationOf(routine.conversation_id!).deleted_at).not.toBeNull();
		expect(conversationOf(answered.conversationId).deleted_at).toBeNull();
		expect(events).toContainEqual({
			type: 'conversation.deleted',
			conversationId: routine.conversation_id
		});
	});
});

describe('restart', () => {
	it('failRunningAgentRuns leaves runs waiting for an answer untouched', async () => {
		const agent = seedAgent('any');
		const { run } = await awaitingRun(agent.id);
		const stuck = seedAgent('never', 'stuck');
		db.prepare(
			`INSERT INTO agent_runs (id, agent_id, user_id, trigger, status, started_at)
			 VALUES ('stuck-run', ?, 'u1', 'manual', 'running', ?)`
		).run(stuck.id, Date.now());

		expect(failRunningAgentRuns(db)).toBe(1);
		expect(getAgentRun(db, run.id)!.status).toBe('awaiting_input');
		expect(getAgentRun(db, 'stuck-run')).toMatchObject({
			status: 'failed',
			error: 'Interrupted by server restart'
		});
	});
});

describe('edit and regenerate in an awaiting run', () => {
	it('regenerating the question rewinds the run without the "user has replied" header', async () => {
		const agent = seedAgent('any');
		const { run, conversationId } = await awaitingRun(agent.id);
		const [userMessage, question] = listMessages(db, conversationId);

		await postChat({
			conversationId,
			message: { id: userMessage.id, role: 'user', parts: JSON.parse(userMessage.parts) },
			branchFrom: question.id
		});
		await vi.waitFor(() => expect(getAgentRun(db, run.id)!.status).not.toBe('running'));
		const call = model.calls.at(-1)!;
		expect(call.system).toContain('You are running autonomously');
		expect(call.system).not.toContain('The user has replied');
		expect(askUserAnswerIn(call)).toBeNull();
		expect(getAgentRun(db, run.id)!.status).toBe('success');
	});

	it('editing the first message rewinds the run without the "user has replied" header', async () => {
		const agent = seedAgent('any');
		const { run, conversationId } = await awaitingRun(agent.id);
		const [userMessage] = listMessages(db, conversationId);

		await postChat({
			conversationId,
			message: {
				id: 'edited-instructions',
				role: 'user',
				parts: [{ type: 'text', text: 'Only archive the old ones.' }]
			},
			branchFrom: userMessage.id
		});
		await vi.waitFor(() => expect(getAgentRun(db, run.id)!.status).not.toBe('running'));
		const call = model.calls.at(-1)!;
		expect(call.system).not.toContain('The user has replied');
		expect(JSON.stringify(call.prompt)).toContain('Only archive the old ones.');
		expect(getAgentRun(db, run.id)!.status).toBe('success');
	});

	// An edit (or regenerate) rewinds the run without counting as an answer,
	// but the user took part all the same: the chat stays in the active list.
	it('keeps the chat active after the user edited in it', async () => {
		const agent = seedAgent('any');
		const { run, conversationId } = await awaitingRun(agent.id);
		const [userMessage] = listMessages(db, conversationId);
		await postChat({
			conversationId,
			message: {
				id: 'edited-instructions',
				role: 'user',
				parts: [{ type: 'text', text: 'Only archive the old ones.' }]
			},
			branchFrom: userMessage.id
		});
		await runSettles(run.id, 'success');
		expect(conversationOf(conversationId).settled_at).toBeNull();
	});
});

// Keep last: shutting down permanently closes this module instance to new runs.
describe('shutdown', () => {
	it('stopAllAgentRuns fails running turns and refuses new runs', async () => {
		const agent = seedAgent('any');
		const waiting = await awaitingRun(agent.id);
		const hidden = seedAgent('never', 'hidden');
		model.queue.push({ kind: 'hang' });
		const { run, done } = await dispatch(hidden.id);
		await vi.waitFor(() => expect(model.calls).toHaveLength(2));

		await stopAllAgentRuns(5000);
		expect(await done).toMatchObject({
			status: 'failed',
			error: 'Interrupted by server shutdown'
		});
		expect(getAgentRun(db, run.id)!.status).toBe('failed');
		// A run waiting for an answer has no turn to interrupt.
		expect(getAgentRun(db, waiting.run.id)!.status).toBe('awaiting_input');
		await expect(dispatch(agent.id)).rejects.toThrow('shutting down');
	});
});
