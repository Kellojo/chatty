import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { getDb, closeDb } = await import('$lib/server/db/index.js');
const { POST } = await import('./+server.js');
const { registerStream, releaseStream } = await import('$lib/server/chat/streams.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');

async function call(conversationId: string, userId: string | null) {
	const event = {
		locals: { user: userId ? { id: userId, role: 'user' } : null, session: null },
		params: { id: conversationId }
	};
	try {
		return await POST(event as never);
	} catch (e) {
		if (isHttpError(e)) return new Response(null, { status: e.status });
		throw e;
	}
}

describe('POST /api/chat/[id]/abort', () => {
	let controller: AbortController;
	let conversationId: string;

	beforeEach(() => {
		closeDb();
		const db = getDb();
		for (const id of ['u1', 'u2']) {
			db.prepare(
				'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, \'user\')'
			).run(id, id, `${id}@b.c`);
		}
		conversationId = createConversation(db, 'u1', {}).id;
		controller = new AbortController();
		registerStream(conversationId, controller);
		return () => {
			releaseStream(conversationId, controller);
		};
	});

	it('returns 401 when unauthenticated', async () => {
		const res = await call(conversationId, null);
		expect(res.status).toBe(401);
		expect(controller.signal.aborted).toBe(false);
	});

	it("does not let a user abort another user's stream", async () => {
		const res = await call(conversationId, 'u2');
		expect(res.status).toBe(404);
		expect(controller.signal.aborted).toBe(false);
	});

	it('aborts the stream for the owner', async () => {
		const res = await call(conversationId, 'u1');
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ aborted: true });
		expect(controller.signal.aborted).toBe(true);
	});
});
