import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { createChatSearchServer } = await import('./chat-search.js');
const { getDb } = await import('../../db/index.js');
const { createConversation } = await import('../../db/repo/conversations.js');
const { createMessage } = await import('../../db/repo/messages.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

const ctx = { userId: 'u1', role: 'user', workspaceDir: null, documentsDir: '' };

let ownId: string;
let ownByMessageId: string;
let otherId: string;
let readId: string;

beforeAll(() => {
	const db = getDb();
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
	).run();
	ownId = createConversation(db, 'u1', { title: 'quarterly budget' }).id;
	ownByMessageId = createConversation(db, 'u1', { title: 'random title' }).id;
	createMessage(db, {
		conversationId: ownByMessageId,
		role: 'user',
		parts: [{ type: 'text', text: 'tell me about the quarterly report' }]
	});
	otherId = createConversation(db, 'u2', { title: 'quarterly budget' }).id;
	readId = createConversation(db, 'u1', { title: 'read me' }).id;
	for (const [i, text] of ['first', 'second', 'third'].entries()) {
		createMessage(db, {
			conversationId: readId,
			role: i % 2 === 0 ? 'user' : 'assistant',
			parts: [{ type: 'text', text }],
			createdAt: i + 1
		});
	}
	const setUpdated = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
	setUpdated.run(1000, ownId);
	setUpdated.run(2000, ownByMessageId);
	setUpdated.run(3000, readId);
	setUpdated.run(4000, otherId);
});

async function callTool(name: string, args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createChatSearchServer(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return await tool.execute(args, { toolCallId: 't1', messages: [] });
	} finally {
		await client.close();
		await server.close();
	}
}

async function callSearch(args: Record<string, unknown>) {
	return callTool('search_chats', args);
}

function resultText(res: unknown): string {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	return r.content?.[0]?.text ?? '';
}

describe('chat-search server', () => {
	it("finds own conversations by title and message content, not other users'", async () => {
		const res = await callSearch({ query: 'quarterly' });
		const hits = JSON.parse(resultText(res)) as Array<{
			id: string;
			title: string;
			updatedAt: number;
		}>;
		const ids = new Set(hits.map((h) => h.id));
		expect(ids.has(ownId)).toBe(true);
		expect(ids.has(ownByMessageId)).toBe(true);
		expect(ids.has(otherId)).toBe(false);
		for (const h of hits) {
			expect(typeof h.title).toBe('string');
			expect(typeof h.updatedAt).toBe('number');
		}
	});

	it('honours the limit argument', async () => {
		const res = await callSearch({ query: 'quarterly', limit: 1 });
		const hits = JSON.parse(resultText(res)) as unknown[];
		expect(hits).toHaveLength(1);
	});

	it('rejects an empty query', async () => {
		const res = await callSearch({ query: '   ' });
		expect((res as { isError?: boolean }).isError).toBe(true);
	});

	it('rejects a call with neither query nor since', async () => {
		const res = await callSearch({});
		expect((res as { isError?: boolean }).isError).toBe(true);
	});

	it('lists own chats updated since an ISO timestamp without a query', async () => {
		const res = await callSearch({ since: '1970-01-01T00:00:02.000Z' });
		const hits = JSON.parse(resultText(res)) as Array<{ id: string; updatedAt: number }>;
		const ids = hits.map((h) => h.id);
		expect(ids).toEqual([readId, ownByMessageId]);
		expect(ids).not.toContain(otherId);
	});

	it('accepts epoch ms for since', async () => {
		const res = await callSearch({ since: '3000' });
		const hits = JSON.parse(resultText(res)) as Array<{ id: string }>;
		expect(hits.map((h) => h.id)).toEqual([readId]);
	});

	it('combines query with the since filter', async () => {
		const res = await callSearch({ query: 'quarterly', since: '1500' });
		const hits = JSON.parse(resultText(res)) as Array<{ id: string }>;
		expect(hits.map((h) => h.id)).toEqual([ownByMessageId]);
	});

	it('tags coding threads with their project and status, for query and since', async () => {
		const db = getDb();
		const codingId = createConversation(db, 'u1', { title: 'fix the flaky test' }).id;
		db.prepare(
			`INSERT INTO coding_conversations (conversation_id, project_id, project_title,
			   provider_instance_id, model, runtime_mode, branch, status, diff_insertions,
			   diff_deletions, created_at, updated_at)
			 VALUES (?, 'p1', 'kellojo-website', 'codex', 'gpt', 'full-access', 'fix/flaky',
			   'idle', 12, 3, 0, 0)`
		).run(codingId);
		db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(5000, codingId);
		type Hit = { id: string; coding?: Record<string, unknown> };

		const byQuery = JSON.parse(resultText(await callSearch({ query: 'flaky' }))) as Hit[];
		expect(byQuery.map((h) => h.id)).toEqual([codingId]);
		expect(byQuery[0].coding).toEqual({
			project: 'kellojo-website',
			status: 'idle',
			provider: 'codex',
			model: 'gpt',
			autonomy: 'full-access',
			workspace: expect.any(String),
			branch: 'fix/flaky',
			linesAdded: 12,
			linesRemoved: 3
		});

		const bySince = JSON.parse(resultText(await callSearch({ since: '2500' }))) as Hit[];
		expect(bySince.find((h) => h.id === codingId)?.coding?.project).toBe('kellojo-website');
		expect(bySince.find((h) => h.id === readId)).not.toHaveProperty('coding');

		db.prepare('DELETE FROM conversations WHERE id = ?').run(codingId);
	});

	it('rejects an unparseable since value', async () => {
		const res = await callSearch({ since: 'next tuesday-ish' });
		expect((res as { isError?: boolean }).isError).toBe(true);
	});
});

describe('read_chat tool', () => {
	it("returns own conversation's messages oldest to newest with text", async () => {
		const res = await callTool('read_chat', { conversationId: readId });
		const msgs = JSON.parse(resultText(res)) as Array<{
			role: string;
			text: string;
			createdAt: number;
			status: string;
		}>;
		expect(msgs.map((m) => m.text)).toEqual(['first', 'second', 'third']);
		expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
		expect(msgs.map((m) => m.createdAt)).toEqual([1, 2, 3]);
		expect(msgs[0].status).toBe('complete');
	});

	it("rejects another user's conversation id", async () => {
		const res = await callTool('read_chat', { conversationId: otherId });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('conversation not found');
	});

	it('rejects an unknown conversation id', async () => {
		const res = await callTool('read_chat', { conversationId: 'nope' });
		expect((res as { isError?: boolean }).isError).toBe(true);
	});

	it('honours the limit argument, keeping the last messages', async () => {
		const res = await callTool('read_chat', { conversationId: readId, limit: 2 });
		const msgs = JSON.parse(resultText(res)) as Array<{ text: string }>;
		expect(msgs.map((m) => m.text)).toEqual(['second', 'third']);
	});
});
