import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

vi.mock('../llm/registry.js', async () => {
	const { MockLanguageModelV3 } = await import('ai/test');
	const { simulateReadableStream } = await import('ai');
	const model = new MockLanguageModelV3({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{ type: 'text-start', id: 't1' },
					{ type: 'text-delta', id: 't1', delta: 'Hi ' },
					{ type: 'text-delta', id: 't1', delta: 'there' },
					{ type: 'text-end', id: 't1' },
					{
						type: 'finish',
						finishReason: 'stop',
						usage: {
							inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
							outputTokens: { total: 2, text: 2, reasoning: undefined }
						}
					} as never
				]
			})
		})
	});
	return {
		resolveModel: () => model,
		roleModel: () => undefined,
		ModelUnavailableError: class ModelUnavailableError extends Error {}
	};
});

vi.mock('../llm/mapped.js', () => ({
	resolveRefTargets: (ref: { providerId: string; modelId: string }) => ({
		mappingId: null,
		targets: [{ providerId: ref.providerId, modelId: ref.modelId }]
	}),
	isRetryableModelError: () => false
}));

const { getDb, closeDb } = await import('../db/index.js');
const { handleChatRequest } = await import('./service.js');
const { createConversation, getConversation } = await import('../db/repo/conversations.js');
const { listMessages } = await import('../db/repo/messages.js');
const { createProvider } = await import('../db/repo/providers.js');
const { createModel } = await import('../db/repo/models.js');

type Db = ReturnType<typeof getDb>;

function seed(db: Db) {
	db.prepare(
		"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
	).run();
	createProvider(db, { name: 'P', type: 'openai-compatible' });
	db.prepare("UPDATE providers SET id = 'p1'").run();
	createModel(db, { providerId: 'p1', modelId: 'm1' });
	const conversation = createConversation(db, 'u1', { providerId: 'p1', modelId: 'm1' });
	db.prepare("UPDATE conversations SET title = 't' WHERE id = ?").run(conversation.id);
	return conversation;
}

describe('handleChatRequest', () => {
	it('persists user and assistant messages with real ids', async () => {
		const db = getDb();
		const conversation = seed(db);

		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			messages: [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]
		});
		expect(res.status).toBe(200);
		await res.text();
		await new Promise((r) => setTimeout(r, 50));

		const messages = listMessages(db, conversation.id);
		expect(messages).toHaveLength(2);
		const assistant = messages.find((m) => m.role === 'assistant')!;
		expect(assistant.id).toBeTruthy();
		expect(assistant.status).toBe('complete');
		expect(JSON.parse(assistant.parts)).toContainEqual(
			expect.objectContaining({ type: 'text', text: 'Hi there' })
		);
		closeDb();
	});

	it('persists assistant messages across multiple turns (no id collision)', async () => {
		const db = getDb();
		const conversation = seed(db);

		const first = await handleChatRequest('u1', {
			conversationId: conversation.id,
			messages: [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]
		});
		await first.text();
		await new Promise((r) => setTimeout(r, 50));
		const afterFirst = listMessages(db, conversation.id);
		const assistant1 = afterFirst.find((m) => m.role === 'assistant')!;

		const second = await handleChatRequest('u1', {
			conversationId: conversation.id,
			messages: [
				{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
				{
					id: assistant1.id,
					role: 'assistant',
					parts: JSON.parse(assistant1.parts) as never[]
				},
				{ id: 'msg-2', role: 'user', parts: [{ type: 'text', text: 'again' }] }
			]
		});
		expect(second.status).toBe(200);
		await second.text();
		await new Promise((r) => setTimeout(r, 50));

		const messages = listMessages(db, conversation.id);
		expect(messages).toHaveLength(4);
		const assistants = messages.filter((m) => m.role === 'assistant');
		expect(new Set(assistants.map((m) => m.id)).size).toBe(2);
		closeDb();
	});

	it('sets a provisional title from the first user message when empty', async () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
		).run();
		createProvider(db, { name: 'P', type: 'openai-compatible' });
		db.prepare("UPDATE providers SET id = 'p1'").run();
		createModel(db, { providerId: 'p1', modelId: 'm1' });
		const conversation = createConversation(db, 'u1', { providerId: 'p1', modelId: 'm1' });

		expect(getConversation(db, 'u1', conversation.id)!.title).toBe('');

		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			messages: [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello world' }] }]
		});
		expect(res.status).toBe(200);
		await res.text();
		await new Promise((r) => setTimeout(r, 50));

		const title = getConversation(db, 'u1', conversation.id)!.title;
		expect(title).toBeTruthy();
		expect(title).not.toBe('');
		closeDb();
	});

	it('truncates long first messages at a word boundary and appends ellipsis', async () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
		).run();
		createProvider(db, { name: 'P', type: 'openai-compatible' });
		db.prepare("UPDATE providers SET id = 'p1'").run();
		createModel(db, { providerId: 'p1', modelId: 'm1' });
		const conversation = createConversation(db, 'u1', { providerId: 'p1', modelId: 'm1' });

		const longPrompt = Array.from({ length: 20 }, (_, i) => `word${i + 1}`).join(' ');

		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			messages: [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: longPrompt }] }]
		});
		expect(res.status).toBe(200);
		await res.text();
		await new Promise((r) => setTimeout(r, 50));

		const title = getConversation(db, 'u1', conversation.id)!.title;
		expect(title.endsWith('\u2026')).toBe(true);
		expect(title.split(' ').pop()).not.toBe('\u2026');
		closeDb();
	});

	it('persists usage metadata on the assistant message', async () => {
		const db = getDb();
		const conversation = seed(db);

		const res = await handleChatRequest('u1', {
			conversationId: conversation.id,
			messages: [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		await new Promise((r) => setTimeout(r, 50));

		// metadata chunk streamed to the client
		expect(body).toContain('"usage"');

		const assistant = listMessages(db, conversation.id).find((m) => m.role === 'assistant')!;
		const usage = JSON.parse(assistant.usage_json!) as Record<string, unknown>;
		expect(usage).toMatchObject({
			providerId: 'p1',
			modelId: 'm1',
			inputTokens: 1,
			outputTokens: 2,
			totalTokens: 3
		});
		expect(typeof usage.latencyMs).toBe('number');
		closeDb();
	});

	it('rejects with 400 when the selected model is disabled', async () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
		).run();
		const provider = createProvider(db, { name: 'P', type: 'openai-compatible' });
		createModel(db, { providerId: provider.id, modelId: 'm1', enabled: false });
		const conversation = createConversation(db, 'u1', {
			providerId: provider.id,
			modelId: 'm1'
		});

		await expect(
			handleChatRequest('u1', {
				conversationId: conversation.id,
				messages: [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]
			})
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringContaining('disabled')
		});
		closeDb();
	});

	it('rejects with 400 when the selected provider is disabled', async () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
		).run();
		const provider = createProvider(db, {
			name: 'P',
			type: 'openai-compatible',
			enabled: false
		});
		createModel(db, { providerId: provider.id, modelId: 'm1' });
		const conversation = createConversation(db, 'u1', {
			providerId: provider.id,
			modelId: 'm1'
		});

		await expect(
			handleChatRequest('u1', {
				conversationId: conversation.id,
				messages: [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]
			})
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringContaining('unavailable')
		});
		closeDb();
	});
});
