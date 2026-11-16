import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createAgent } = await import('$lib/server/db/repo/agents.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');
const { createMessage } = await import('$lib/server/db/repo/messages.js');
const { PATCH } = await import('./+server.js');

type Db = ReturnType<typeof getDb>;

interface CallInit {
	user?: { id: string; role?: string } | null;
	params?: Record<string, string>;
	body?: unknown;
	url?: string;
	headers?: Record<string, string>;
	method?: string;
}

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: CallInit = {}
): Promise<{ status: number; body: T }> {
	const url = new URL(init.url ?? 'http://localhost/api/conversations');
	const headers = new Headers(init.headers);
	let body: string | undefined;
	if (init.body !== undefined) {
		headers.set('content-type', 'application/json');
		body = JSON.stringify(init.body);
	}
	const event = {
		locals: { user: init.user ?? null, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, {
			method: init.method ?? (body !== undefined ? 'PATCH' : 'GET'),
			headers,
			body
		}),
		url
	};
	try {
		const res = await handler(event as never);
		return { status: res.status, body: (await res.json()) as T };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body as T };
		throw e;
	}
}

const u1 = { id: 'u1', role: 'user' };

function seedUsers(db: Db) {
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
	).run();
}

function createPersona(db: Db, name: string) {
	return createAgent(db, 'u1', { name, systemPrompt: 'x', triggerType: 'persona' });
}

beforeEach(() => {
	closeDb();
	seedUsers(getDb());
});

describe('PATCH /api/conversations/[id] agentId guard', () => {
	it('rejects changing agentId once the conversation has messages', async () => {
		const db = getDb();
		const a1 = createPersona(db, 'a1');
		const a2 = createPersona(db, 'a2');
		const conversation = createConversation(db, 'u1', { agentId: a1.id });
		createMessage(db, {
			conversationId: conversation.id,
			role: 'user',
			parts: [{ type: 'text', text: 'hi' }]
		});
		const res = await call<{ message: string }>(PATCH, {
			user: u1,
			params: { id: conversation.id },
			body: { agentId: a2.id }
		});
		expect(res.status).toBe(409);
		expect(res.body.message).toBe('Persona can only be changed before the first message');
	});

	it('still allows patching other fields when messages exist', async () => {
		const db = getDb();
		const a1 = createPersona(db, 'a1');
		const conversation = createConversation(db, 'u1', { agentId: a1.id });
		createMessage(db, {
			conversationId: conversation.id,
			role: 'user',
			parts: [{ type: 'text', text: 'hi' }]
		});
		const res = await call<{ conversation: { title: string; agentId: string | null } }>(PATCH, {
			user: u1,
			params: { id: conversation.id },
			body: { title: 'Renamed' }
		});
		expect(res.status).toBe(200);
		expect(res.body.conversation.title).toBe('Renamed');
		expect(res.body.conversation.agentId).toBe(a1.id);
	});

	it('allows setting agentId before the first message', async () => {
		const db = getDb();
		const a1 = createPersona(db, 'a1');
		const conversation = createConversation(db, 'u1');
		const res = await call<{ conversation: { agentId: string | null } }>(PATCH, {
			user: u1,
			params: { id: conversation.id },
			body: { agentId: a1.id }
		});
		expect(res.status).toBe(200);
		expect(res.body.conversation.agentId).toBe(a1.id);
	});

	it('allows re-setting the same agentId when messages exist', async () => {
		const db = getDb();
		const a1 = createPersona(db, 'a1');
		const conversation = createConversation(db, 'u1', { agentId: a1.id });
		createMessage(db, {
			conversationId: conversation.id,
			role: 'user',
			parts: [{ type: 'text', text: 'hi' }]
		});
		const res = await call<{ conversation: { agentId: string | null } }>(PATCH, {
			user: u1,
			params: { id: conversation.id },
			body: { agentId: a1.id }
		});
		expect(res.status).toBe(200);
		expect(res.body.conversation.agentId).toBe(a1.id);
	});
});
