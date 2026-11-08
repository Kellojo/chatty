import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');
const { createMessage } = await import('$lib/server/db/repo/messages.js');
const { GET } = await import('./+server.js');

interface Page {
	messages: { id: string; parts: unknown[] }[];
	hasOlder: boolean;
	message?: string;
}

async function get(
	user: { id: string } | null,
	id: string,
	query = ''
): Promise<{ status: number; body: Page }> {
	const url = new URL(`http://localhost/api/conversations/${id}/messages${query}`);
	const event = {
		locals: { user, session: null } as unknown as App.Locals,
		params: { id },
		request: new Request(url),
		url
	};
	try {
		const res = await GET(event as never);
		return { status: res.status, body: (await res.json()) as Page };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body as Page };
		throw e;
	}
}

const u1 = { id: 'u1', role: 'user' };

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
			 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'), ('u2', 'b@b.c', 'B', 0, 0, 0, 'user')`
		)
		.run();
});

function seed(n: number) {
	const db = getDb();
	const conversationId = createConversation(db, 'u1').id;
	const ids = Array.from(
		{ length: n },
		(_, i) =>
			createMessage(db, {
				conversationId,
				role: i % 2 ? 'assistant' : 'user',
				parts: [{ type: 'text', text: `m${i}` }],
				createdAt: 1000 + i
			}).id
	);
	return { conversationId, ids };
}

describe('GET /api/conversations/[id]/messages', () => {
	it('returns the newest 60 messages by default, oldest first', async () => {
		const { conversationId, ids } = seed(70);
		const res = await get(u1, conversationId);
		expect(res.status).toBe(200);
		expect(res.body.messages.map((m) => m.id)).toEqual(ids.slice(10));
		expect(res.body.hasOlder).toBe(true);
		expect(res.body.messages[0].parts).toEqual([{ type: 'text', text: 'm10' }]);
	});

	it('pages backwards with before + limit', async () => {
		const { conversationId, ids } = seed(10);
		const res = await get(u1, conversationId, `?before=${ids[5]}&limit=3`);
		expect(res.body.messages.map((m) => m.id)).toEqual(ids.slice(2, 5));
		expect(res.body.hasOlder).toBe(true);
		const rest = await get(u1, conversationId, `?before=${ids[2]}&limit=3`);
		expect(rest.body.messages.map((m) => m.id)).toEqual(ids.slice(0, 2));
		expect(rest.body.hasOlder).toBe(false);
	});

	it('caps the limit at 200', async () => {
		const { conversationId } = seed(205);
		const res = await get(u1, conversationId, '?limit=1000');
		expect(res.body.messages).toHaveLength(200);
		expect(res.body.hasOlder).toBe(true);
	});

	it('404s for a foreign conversation', async () => {
		const { conversationId } = seed(2);
		expect((await get({ id: 'u2' }, conversationId)).status).toBe(404);
	});

	it('400s for an unknown before id or a bad limit', async () => {
		const { conversationId } = seed(2);
		const other = seed(1);
		expect((await get(u1, conversationId, '?before=nope')).status).toBe(400);
		expect((await get(u1, conversationId, `?before=${other.ids[0]}`)).status).toBe(400);
		expect((await get(u1, conversationId, '?limit=abc')).status).toBe(400);
	});

	it('pages the active branch only, with version info', async () => {
		const { conversationId, ids } = seed(4);
		const db = getDb();
		// An edit of the third message: a sibling that continues from the second.
		const edit = createMessage(db, {
			conversationId,
			role: 'user',
			parts: [{ type: 'text', text: 'edited' }],
			createdAt: 2000,
			parentId: ids[1]
		}).id;
		const res = await get(u1, conversationId);
		expect(res.body.messages.map((m) => m.id)).toEqual([ids[0], ids[1], edit]);
		const last = res.body.messages[2] as { branch?: { index: number; count: number } };
		expect(last.branch).toMatchObject({ index: 1, count: 2 });
		// the replaced version is no longer part of this history
		expect((await get(u1, conversationId, `?before=${ids[3]}`)).status).toBe(400);
		const older = await get(u1, conversationId, `?before=${edit}&limit=1`);
		expect(older.body.messages.map((m) => m.id)).toEqual([ids[1]]);
	});

	it('401s without a user', async () => {
		const { conversationId } = seed(1);
		expect((await get(null, conversationId)).status).toBe(401);
	});
});
