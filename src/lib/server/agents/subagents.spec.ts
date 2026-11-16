import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

type TurnOutcome = import('./run-lifecycle.js').TurnOutcome;

// The chat turn itself is the chat engine's job; here it writes a reply and ends.
const turn = vi.fn();
vi.doMock('../chat/service.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../chat/service.js')>()),
	runChatTurnHeadless: turn
}));
const abortStream = vi.fn();
vi.doMock('../chat/streams.js', () => ({ abortStream }));

const { runSubagent, subagentAllowlist, cutReport, SubagentError, SUBAGENT_RESULT_MAX_CHARS } =
	await import('./subagents.js');
const { getDb } = await import('../db/index.js');
const { createAgent } = await import('../db/repo/agents.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { workspaceForConversation, conversationWorkspace } = await import('../workspaces.js');

const done: TurnOutcome = { status: 'complete', error: null, abortReason: null, openAskUser: null };

/** A turn that answers with `reply` in the subagent's conversation. */
function replies(reply: string, outcome: TurnOutcome = done) {
	turn.mockImplementationOnce(async (_userId: string, conversation: { id: string }) => {
		createMessage(getDb(), {
			conversationId: conversation.id,
			role: 'assistant',
			parts: [{ type: 'text', text: reply }]
		});
		return outcome;
	});
}

beforeAll(() => {
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		)
		.run();
});

beforeEach(() => {
	turn.mockReset();
	abortStream.mockReset();
});

describe('subagentAllowlist', () => {
	it("keeps the parent's tools when none are requested", () => {
		expect(subagentAllowlist(undefined, undefined)).toEqual({ allowlist: undefined, dropped: [] });
		expect(subagentAllowlist(['a', 'b'], undefined).allowlist).toEqual(['a', 'b']);
	});

	it('never adds a tool the parent lacks, and names the ones it dropped', () => {
		expect(subagentAllowlist(['a', 'b'], ['b', 'c', 'b'])).toEqual({
			allowlist: ['b'],
			dropped: ['c']
		});
		expect(subagentAllowlist(undefined, ['c', 'c'])).toEqual({ allowlist: ['c'], dropped: [] });
	});
});

describe('cutReport', () => {
	it('leaves short reports alone and marks the cut in long ones', () => {
		expect(cutReport('short', 10)).toEqual({ text: 'short', truncated: false });
		const cut = cutReport('abcdefghij', 4);
		expect(cut.truncated).toBe(true);
		expect(cut.text).toMatch(/^abcd\n\n\[Report shortened here/);
	});

	it('never splits a surrogate pair', () => {
		// "a😀b": the emoji is two UTF-16 units, at indexes 1 and 2.
		expect(cutReport('a😀bcd', 2).text.startsWith('a\n')).toBe(true);
	});
});

describe('runSubagent', () => {
	const start = (parentConversationId: string, extra: Record<string, unknown> = {}) =>
		runSubagent({
			userId: 'u1',
			parentConversationId,
			description: 'Find the docs',
			prompt: 'Find the docs for X',
			...extra
		});

	it('runs in a hidden conversation of its own and returns its final reply', async () => {
		const db = getDb();
		const parent = createConversation(db, 'u1', { providerId: 'p', modelId: 'm', maxSteps: 7 });
		db.prepare('UPDATE conversations SET memory_enabled = 0 WHERE id = ?').run(parent.id);
		replies('## Found\n\nThe docs are at https://example.com.');
		const result = await start(parent.id);
		expect(result).toMatchObject({
			status: 'completed',
			result: '## Found\n\nThe docs are at https://example.com.',
			truncated: false
		});
		const sub = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.conversationId);
		expect(sub).toMatchObject({
			kind: 'agent-run',
			subagent_of: parent.id,
			provider_id: 'p',
			model_id: 'm',
			max_steps: 7,
			memory_enabled: 0
		});
		// Same tools as the chat (no allowlist), but never subagents or questions for the user.
		expect(turn.mock.calls[0][3]).toEqual({
			tools: { allowlist: undefined, exclude: ['run_subagent', 'ask_user'] }
		});
	});

	it("limits a persona chat's subagent to the persona's tools", async () => {
		const db = getDb();
		const persona = createAgent(db, 'u1', {
			name: 'researcher',
			systemPrompt: 'research',
			triggerType: 'persona',
			toolAllowlist: ['fetch', 'search_chats']
		});
		const parent = createConversation(db, 'u1', { agentId: persona.id });
		replies('ok');
		replies('ok');
		await start(parent.id);
		const narrowed = await start(parent.id, { tools: ['fetch', 'run_code'] });
		expect(turn.mock.calls[0][3].tools.allowlist).toEqual(['fetch', 'search_chats']);
		expect(turn.mock.calls[1][3].tools.allowlist).toEqual(['fetch']);
		expect(narrowed.droppedTools).toEqual(['run_code']);
	});

	it('refuses tools the parent has none of', async () => {
		const db = getDb();
		const persona = createAgent(db, 'u1', {
			name: 'narrow',
			systemPrompt: 'x',
			triggerType: 'persona',
			toolAllowlist: ['fetch']
		});
		const parent = createConversation(db, 'u1', { agentId: persona.id });
		await expect(start(parent.id, { tools: ['run_code'] })).rejects.toBeInstanceOf(SubagentError);
		expect(turn).not.toHaveBeenCalled();
	});

	it('refuses to start from a subagent', async () => {
		const db = getDb();
		const parent = createConversation(db, 'u1');
		const sub = createConversation(db, 'u1', { kind: 'agent-run', subagentOf: parent.id });
		await expect(start(sub.id)).rejects.toThrow(/cannot start subagents/);
	});

	it('caps the subagents working for one conversation at once', async () => {
		const parent = createConversation(getDb(), 'u1');
		const release: (() => void)[] = [];
		turn.mockImplementation(
			() => new Promise<TurnOutcome>((resolve) => release.push(() => resolve(done)))
		);
		const first = [1, 2, 3, 4].map(() => start(parent.id));
		await vi.waitFor(() => expect(release).toHaveLength(4));
		await expect(start(parent.id)).rejects.toThrow(/already working/);
		release.forEach((r) => r());
		await Promise.all(first);
		// Once they finished there is room again.
		turn.mockReset();
		replies('again');
		await expect(start(parent.id)).resolves.toMatchObject({ result: 'again' });
	});

	it("stops with the parent's call", async () => {
		const parent = createConversation(getDb(), 'u1');
		const controller = new AbortController();
		turn.mockImplementationOnce(async () => {
			controller.abort();
			return { status: 'aborted', error: null, abortReason: 'stopped', openAskUser: null };
		});
		const result = await start(parent.id, { signal: controller.signal });
		expect(result.status).toBe('stopped');
		expect(abortStream).toHaveBeenCalledWith(result.conversationId, 'stopped');
	});

	it('shortens a long report and reports failures', async () => {
		const parent = createConversation(getDb(), 'u1');
		replies('x'.repeat(SUBAGENT_RESULT_MAX_CHARS + 10));
		const long = await start(parent.id);
		expect(long.truncated).toBe(true);
		expect(long.result?.startsWith('x'.repeat(SUBAGENT_RESULT_MAX_CHARS))).toBe(true);
		expect(long.result).toMatch(/Report shortened here/);
		replies('', {
			status: 'failed',
			error: 'model unavailable',
			abortReason: null,
			openAskUser: null
		});
		await expect(start(parent.id)).resolves.toMatchObject({
			status: 'failed',
			result: null,
			error: 'model unavailable'
		});
	});

	it("works in the parent's workspace", () => {
		const db = getDb();
		const parent = createConversation(db, 'u1');
		const sub = createConversation(db, 'u1', { kind: 'agent-run', subagentOf: parent.id });
		expect(workspaceForConversation(db, sub)).toBe(conversationWorkspace(parent.id));
	});
});

describe('describeSubagent / findSubagentForToolCall', () => {
	it('finds the subagent a tool call started and reports how it ended', async () => {
		const { describeSubagent, findSubagentForToolCall } = await import('./subagents.js');
		const db = getDb();
		const parent = createConversation(db, 'u1', { title: 'Research chat' });
		replies('Report');
		const { conversationId } = await runSubagent({
			userId: 'u1',
			parentConversationId: parent.id,
			description: 'Find the docs',
			prompt: 'Find them',
			toolCallId: 'call-1'
		});
		const found = findSubagentForToolCall(db, 'u1', parent.id, 'call-1');
		expect(found).toMatchObject({
			id: conversationId,
			description: 'Find the docs',
			parentId: parent.id,
			parentTitle: 'Research chat',
			parentIsChat: true,
			status: 'completed',
			error: null
		});
		expect(found?.endedAt).toEqual(expect.any(Number));
		expect(findSubagentForToolCall(db, 'u1', parent.id, 'other')).toBeNull();
		expect(describeSubagent(db, 'u2', conversationId)).toBeNull();
		// A conversation that isn't a subagent's is not one.
		expect(describeSubagent(db, 'u1', parent.id)).toBeNull();
	});

	it('is running while its turn works, and failed or stopped after', async () => {
		const { describeSubagent } = await import('./subagents.js');
		const db = getDb();
		const parent = createConversation(db, 'u1');
		let finish!: () => void;
		let subId = '';
		turn.mockImplementationOnce(async (_u: string, conversation: { id: string }) => {
			subId = conversation.id;
			await new Promise<void>((r) => (finish = r));
			createMessage(db, {
				conversationId: conversation.id,
				role: 'assistant',
				parts: [],
				status: 'failed',
				error: 'Response stopped'
			});
			return { status: 'aborted', error: null, abortReason: 'stopped', openAskUser: null };
		});
		const pending = runSubagent({
			userId: 'u1',
			parentConversationId: parent.id,
			description: 'Slow',
			prompt: 'Take long'
		});
		await vi.waitFor(() => expect(subId).not.toBe(''));
		expect(describeSubagent(db, 'u1', subId)).toMatchObject({ status: 'running', endedAt: null });
		finish();
		const result = await pending;
		expect(result).toMatchObject({ status: 'stopped', startedAt: expect.any(Number) });
		expect(describeSubagent(db, 'u1', subId)?.status).toBe('stopped');
	});
});

describe('recorded endings', () => {
	it('reports a subagent the server lost mid-run as interrupted, not completed', async () => {
		const { describeSubagent } = await import('./subagents.js');
		const db = getDb();
		const parent = createConversation(db, 'u1');
		// Created like a subagent, but its runner never recorded an ending.
		const lost = createConversation(db, 'u1', { kind: 'agent-run', subagentOf: parent.id });
		expect(describeSubagent(db, 'u1', lost.id)).toMatchObject({
			status: 'failed',
			error: expect.stringMatching(/without a recorded result/)
		});
	});

	it('records failures with their error, whatever the wording', async () => {
		const { describeSubagent } = await import('./subagents.js');
		const parent = createConversation(getDb(), 'u1');
		replies('', {
			status: 'failed',
			error: 'Upstream aborted the connection',
			abortReason: null,
			openAskUser: null
		});
		const result = await runSubagent({
			userId: 'u1',
			parentConversationId: parent.id,
			description: 'x',
			prompt: 'y'
		});
		// "aborted" in an error message is a failure, not the user stopping it.
		expect(describeSubagent(getDb(), 'u1', result.conversationId)).toMatchObject({
			status: 'failed',
			error: 'Upstream aborted the connection'
		});
	});
});

describe('a turn that throws', () => {
	it('still ends the subagent as failed, with the error recorded', async () => {
		const { describeSubagent } = await import('./subagents.js');
		const parent = createConversation(getDb(), 'u1');
		turn.mockRejectedValueOnce(new Error('database is locked'));
		const result = await runSubagent({
			userId: 'u1',
			parentConversationId: parent.id,
			description: 'x',
			prompt: 'y'
		});
		expect(result).toMatchObject({ status: 'failed', error: 'database is locked' });
		expect(describeSubagent(getDb(), 'u1', result.conversationId)).toMatchObject({
			status: 'failed',
			error: 'database is locked'
		});
	});
});

describe('progress', () => {
	it("follows a running subagent's latest tool step from its stored reply", async () => {
		const { describeSubagent } = await import('./subagents.js');
		const db = getDb();
		const parent = createConversation(db, 'u1');
		let finish!: () => void;
		let subId = '';
		turn.mockImplementationOnce(async (_u: string, conversation: { id: string }) => {
			subId = conversation.id;
			createMessage(db, {
				conversationId: conversation.id,
				role: 'assistant',
				status: 'partial',
				parts: [
					{ type: 'step-start' },
					{
						type: 'dynamic-tool',
						toolName: 'now',
						toolCallId: 'a',
						state: 'output-available',
						input: {}
					},
					{
						type: 'dynamic-tool',
						toolName: 'fetch',
						toolCallId: 'b',
						state: 'input-available',
						input: { url: 'https://example.com/docs' }
					}
				]
			});
			await new Promise<void>((r) => (finish = r));
			return done;
		});
		const pending = runSubagent({
			userId: 'u1',
			parentConversationId: parent.id,
			description: 'Docs',
			prompt: 'Read the docs'
		});
		await vi.waitFor(() => expect(subId).not.toBe(''));
		const progress = describeSubagent(db, 'u1', subId)?.progress;
		expect(progress?.steps).toBe(2);
		expect(progress?.current).toMatch(/example\.com\/docs/);
		finish();
		await pending;
		expect(describeSubagent(db, 'u1', subId)?.progress).toBeNull();
	});
});
