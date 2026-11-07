import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');
const { registerStream, releaseStream } = await import('$lib/server/chat/streams.js');
const { GET } = await import('./+server.js');

type Db = ReturnType<typeof getDb>;

interface CallInit {
	user?: { id: string; role?: string } | null;
}

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: CallInit = {}
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/chat/active');
	const event = {
		locals: { user: init.user ?? null, session: null } as unknown as App.Locals,
		params: {},
		request: new Request(url, { method: 'GET' }),
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
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
		 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
	).run();
}

let registered: Array<{ id: string; controller: AbortController }> = [];

function register(id: string) {
	const controller = new AbortController();
	registerStream(id, controller);
	registered.push({ id, controller });
}

beforeEach(() => {
	for (const { id, controller } of registered) releaseStream(id, controller);
	registered = [];
	closeDb();
	seedUsers(getDb());
});

describe('GET /api/chat/active', () => {
	it('returns 401 when unauthenticated', async () => {
		const res = await call(GET);
		expect(res.status).toBe(401);
	});

	it('returns an empty list when nothing is active', async () => {
		const res = await call<{ conversationIds: string[] }>(GET, { user: u1 });
		expect(res.status).toBe(200);
		expect(res.body.conversationIds).toEqual([]);
	});

	it('returns the id of an active stream on an owned conversation', async () => {
		const conversation = createConversation(getDb(), 'u1', {});
		register(conversation.id);
		const res = await call<{
			conversationIds: string[];
			streams: Array<{ conversationId: string; startedAt: number }>;
		}>(GET, { user: u1 });
		expect(res.status).toBe(200);
		expect(res.body.conversationIds).toEqual([conversation.id]);
		expect(res.body.streams).toEqual([
			{ conversationId: conversation.id, startedAt: expect.any(Number) }
		]);
	});

	it("omits streams on another user's conversation", async () => {
		const mine = createConversation(getDb(), 'u1', {});
		const theirs = createConversation(getDb(), 'u2', {});
		register(mine.id);
		register(theirs.id);
		const res = await call<{ conversationIds: string[] }>(GET, { user: u1 });
		expect(res.status).toBe(200);
		expect(res.body.conversationIds).toEqual([mine.id]);
	});
});
