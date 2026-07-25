import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { getDb, closeDb } = await import('$lib/server/db/index.js');
const { GET } = await import('./+server.js');
const { registerStream, releaseStream, appendChunk, markDone } =
	await import('$lib/server/chat/streams.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');

type Db = ReturnType<typeof getDb>;

function seed(db: Db) {
	db.prepare(
		"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
	).run();
	return createConversation(db, 'u1', {});
}

async function call(conversationId: string, loggedIn = true) {
	const event = {
		locals: { user: loggedIn ? { id: 'u1', role: 'user' } : null, session: null },
		params: { id: conversationId }
	};
	try {
		return await GET(event as never);
	} catch (e) {
		if (isHttpError(e)) return new Response(null, { status: e.status });
		throw e;
	}
}

describe('GET /api/chat/[id]/stream', () => {
	let controller: AbortController;
	let conversationId: string;

	beforeEach(() => {
		closeDb();
		const db = getDb();
		conversationId = seed(db).id;
		controller = new AbortController();
		registerStream(conversationId, controller);
		return () => {
			releaseStream(conversationId, controller);
		};
	});

	it('returns 401 when unauthenticated', async () => {
		const res = await call(conversationId, false);
		expect(res.status).toBe(401);
	});

	it('returns 404 for an unknown conversation', async () => {
		const res = await call('does-not-exist');
		expect(res.status).toBe(404);
	});

	it('returns 204 when no stream is active', async () => {
		releaseStream(conversationId, controller);
		const res = await call(conversationId);
		expect(res.status).toBe(204);
	});

	it('replays buffered chunks then closes when the stream is done', async () => {
		appendChunk(conversationId, { type: 'start', messageId: 'a1' } as never);
		appendChunk(conversationId, { type: 'text-start', id: 't1' } as never);
		appendChunk(conversationId, { type: 'text-delta', id: 't1', delta: 'Hi' } as never);
		markDone(conversationId);

		const res = await call(conversationId);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		const body = await res.text();
		expect(body).toContain('"type":"start"');
		expect(body).toContain('"delta":"Hi"');
		expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
	});

	it('streams live chunks after the replay for an ongoing stream', async () => {
		appendChunk(conversationId, { type: 'start', messageId: 'a1' } as never);

		const res = await call(conversationId);
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let text = '';
		const read = (async () => {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
		})();

		// let the subscription attach, then push a live chunk
		await new Promise((r) => setTimeout(r, 50));
		appendChunk(conversationId, { type: 'text-delta', id: 't1', delta: 'live' } as never);
		markDone(conversationId);
		await read;

		expect(text).toContain('"type":"start"');
		expect(text).toContain('"delta":"live"');
		expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
	});
});
