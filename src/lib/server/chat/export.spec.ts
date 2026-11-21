import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createProxyRequest } = await import('../db/repo/proxy-requests.js');
const { exportFileName, formatConversationExport, loadConversationExport } =
	await import('./export.js');

type Db = ReturnType<typeof getDb>;
let db: Db;

beforeEach(() => {
	closeDb();
	db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'), ('u2', 'd@e.f', 'B', 0, 0, 0, 'user')`
	).run();
});

describe('conversation export', () => {
	it('formats messages, tool calls, requests and subagents as Markdown', () => {
		const c = createConversation(db, 'u1', { title: 'Weather chat', private: false });
		createMessage(db, {
			conversationId: c.id,
			role: 'user',
			parts: [{ type: 'text', text: 'Weather in Berlin?' }],
			createdAt: 1000
		});
		const reply = createMessage(db, {
			conversationId: c.id,
			role: 'assistant',
			status: 'failed',
			error: 'boom',
			createdAt: 2000,
			parts: [
				{ type: 'step-start' },
				{ type: 'reasoning', text: 'Need the weather tool' },
				{
					type: 'dynamic-tool',
					toolName: 'weather',
					toolCallId: 'call1',
					state: 'output-available',
					input: { city: 'Berlin' },
					output: { image: `data:image/png;base64,${'A'.repeat(5000)}`, tempC: 7 }
				},
				{ type: 'text', text: 'It is ```7°C```.' }
			]
		});
		createProxyRequest(db, {
			userId: 'u1',
			endpoint: 'chat',
			requestedModel: 'm1',
			stream: true,
			source: 'chat',
			conversationId: c.id,
			messageId: reply.id
		});
		const sub = createConversation(db, 'u1', {
			kind: 'agent-run',
			title: 'Research subtask',
			subagentOf: c.id,
			private: false
		});
		createMessage(db, {
			conversationId: sub.id,
			role: 'user',
			parts: [{ type: 'text', text: 'Look it up' }]
		});

		const data = loadConversationExport(db, 'u1', c.id)!;
		const md = formatConversationExport(data, 0);

		expect(md).toContain('# Chatty conversation export: Weather chat');
		expect(md).toContain('Weather in Berlin?');
		expect(md).toContain('**Tool call `weather`**');
		expect(md).toContain('"city": "Berlin"');
		expect(md).toContain('inline data elided');
		expect(md).not.toContain('A'.repeat(500));
		expect(md).toContain('Need the weather tool');
		expect(md).toContain('**Error:**');
		expect(md).toContain('## Model requests');
		expect(md).toContain('### Subagent: Research subtask');
		expect(md).toContain('Look it up');
	});

	it('only exports the owner’s conversations', () => {
		const c = createConversation(db, 'u1', { private: false });
		expect(loadConversationExport(db, 'u2', c.id)).toBeUndefined();
		expect(loadConversationExport(db, 'u1', c.id)).toBeDefined();
	});

	it('builds a safe file name', () => {
		expect(exportFileName({ title: 'Hi / "there"!', id: 'abcdef123456' }, 0)).toBe(
			'chatty-hi-there-1970-01-01-abcdef12.md'
		);
		expect(exportFileName({ title: '', id: 'abcdef123456' }, 0)).toBe(
			'chatty-conversation-1970-01-01-abcdef12.md'
		);
	});
});
