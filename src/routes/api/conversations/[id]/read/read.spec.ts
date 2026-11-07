import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createConversation, listUnreadChatIds } =
	await import('$lib/server/db/repo/conversations.js');
const { createMessage } = await import('$lib/server/db/repo/messages.js');
const { POST, DELETE } = await import('./+server.js');

type Db = ReturnType<typeof getDb>;

interface CallInit {
	user?: { id: string; role?: string } | null;
	params?: Record<string, string>;
}

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: CallInit = {}
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/conversations/x/read');
	const event = {
		locals: { user: init.user ?? null, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, { method: 'POST' }),
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
const u2 = { id: 'u2', role: 'user' };

function seedUsers(db: Db) {
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
		 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
	).run();
}

beforeEach(() => {
	closeDb();
	seedUsers(getDb());
});

describe('POST /api/conversations/[id]/read', () => {
	it('returns 401 without auth', async () => {
		const db = getDb();
		const conversation = createConversation(db, 'u1');
		const res = await call(POST, { user: null, params: { id: conversation.id } });
		expect(res.status).toBe(401);
	});

	it("returns 404 for another user's conversation", async () => {
		const db = getDb();
		const conversation = createConversation(db, 'u1');
		const res = await call(POST, { user: u2, params: { id: conversation.id } });
		expect(res.status).toBe(404);
	});

	it('clears the unread state for a chat with a new assistant message', async () => {
		const db = getDb();
		const conversation = createConversation(db, 'u1');
		createMessage(db, {
			conversationId: conversation.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'hello' }]
		});
		expect(listUnreadChatIds(db, 'u1')).toContain(conversation.id);
		const res = await call<{ ok: boolean }>(POST, {
			user: u1,
			params: { id: conversation.id }
		});
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		expect(listUnreadChatIds(db, 'u1')).not.toContain(conversation.id);
	});

	it('does not mark a chat unread when only user messages are new', () => {
		const db = getDb();
		const conversation = createConversation(db, 'u1');
		createMessage(db, {
			conversationId: conversation.id,
			role: 'user',
			parts: [{ type: 'text', text: 'hi' }]
		});
		expect(listUnreadChatIds(db, 'u1')).not.toContain(conversation.id);
	});
});

describe('DELETE /api/conversations/[id]/read', () => {
	it("returns 404 for another user's conversation", async () => {
		const db = getDb();
		const conversation = createConversation(db, 'u1');
		const res = await call(DELETE, { user: u2, params: { id: conversation.id } });
		expect(res.status).toBe(404);
	});

	it('returns 409 when there is no reply to mark unread', async () => {
		const db = getDb();
		const conversation = createConversation(db, 'u1');
		const res = await call(DELETE, { user: u1, params: { id: conversation.id } });
		expect(res.status).toBe(409);
	});

	it('marks a read chat unread again', async () => {
		const db = getDb();
		const conversation = createConversation(db, 'u1');
		createMessage(db, {
			conversationId: conversation.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'hello' }]
		});
		await call(POST, { user: u1, params: { id: conversation.id } });
		expect(listUnreadChatIds(db, 'u1')).not.toContain(conversation.id);
		const res = await call(DELETE, { user: u1, params: { id: conversation.id } });
		expect(res.status).toBe(200);
		expect(listUnreadChatIds(db, 'u1')).toContain(conversation.id);
	});
});
