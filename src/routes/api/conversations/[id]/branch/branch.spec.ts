import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');
const { createMessage, listMessages } = await import('$lib/server/db/repo/messages.js');
const { subscribeServerEvents } = await import('$lib/server/events/bus.js');
const { POST } = await import('./+server.js');

interface Page {
	messages: { id: string; branch?: { index: number; count: number; ids: string[] } }[];
	hasOlder: boolean;
	message?: string;
}

async function post(
	user: { id: string } | null,
	id: string,
	body: unknown
): Promise<{ status: number; body: Page }> {
	const event = {
		locals: { user, session: null } as unknown as App.Locals,
		params: { id },
		request: new Request(`http://localhost/api/conversations/${id}/branch`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	};
	try {
		const res = await POST(event as never);
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

/** user → reply, then the user message edited (edit → editReply). */
function seed() {
	const db = getDb();
	const conversationId = createConversation(db, 'u1').id;
	const text = (t: string) => [{ type: 'text', text: t }];
	const user = createMessage(db, { conversationId, role: 'user', parts: text('q') }).id;
	const reply = createMessage(db, { conversationId, role: 'assistant', parts: text('a') }).id;
	const edit = createMessage(db, {
		conversationId,
		role: 'user',
		parts: text('q2'),
		parentId: null
	}).id;
	const editReply = createMessage(db, { conversationId, role: 'assistant', parts: text('a2') }).id;
	return { conversationId, user, reply, edit, editReply };
}

describe('POST /api/conversations/[id]/branch', () => {
	it('switches to the other version and returns its path', async () => {
		const s = seed();
		const res = await post(u1, s.conversationId, { messageId: s.user });
		expect(res.status).toBe(200);
		expect(res.body.messages.map((m) => m.id)).toEqual([s.user, s.reply]);
		expect(res.body.messages[0].branch).toEqual({ index: 0, count: 2, ids: [s.user, s.edit] });
		expect(res.body.hasOlder).toBe(false);
		// the switch sticks: the next message continues this branch
		expect(listMessages(getDb(), s.conversationId).map((m) => m.id)).toEqual([s.user, s.reply]);
		const back = await post(u1, s.conversationId, { messageId: s.edit });
		expect(back.body.messages.map((m) => m.id)).toEqual([s.edit, s.editReply]);
	});

	it('publishes conversation.branch_changed on a switch only', async () => {
		const s = seed();
		const events: unknown[] = [];
		const stop = subscribeServerEvents('u1', (_user, event) => events.push(event));
		try {
			await post(u1, s.conversationId, { messageId: s.user });
			await post(u1, s.conversationId, { messageId: 'nope' });
		} finally {
			stop();
		}
		expect(events).toEqual([
			{ type: 'conversation.branch_changed', conversationId: s.conversationId }
		]);
	});

	it('404s for a conversation of another user', async () => {
		const s = seed();
		expect((await post({ id: 'u2' }, s.conversationId, { messageId: s.user })).status).toBe(404);
		expect(listMessages(getDb(), s.conversationId).at(-1)?.id).toBe(s.editReply);
	});

	it('400s for an unknown or foreign message id and a bad body', async () => {
		const s = seed();
		const other = seed();
		expect((await post(u1, s.conversationId, { messageId: 'nope' })).status).toBe(400);
		expect((await post(u1, s.conversationId, { messageId: other.user })).status).toBe(400);
		expect((await post(u1, s.conversationId, {})).status).toBe(400);
	});

	it('401s without a user', async () => {
		const s = seed();
		expect((await post(null, s.conversationId, { messageId: s.user })).status).toBe(401);
	});
});
