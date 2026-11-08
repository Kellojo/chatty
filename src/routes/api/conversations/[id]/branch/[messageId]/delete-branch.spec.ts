import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const workspaces = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-branch-'));
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = workspaces;

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');
const { createMessage, getMessage, listMessages } = await import('$lib/server/db/repo/messages.js');
const { createAttachment, linkAttachmentsToMessage, getAttachment } =
	await import('$lib/server/db/repo/attachments.js');
const { createSummary, latestSummary } =
	await import('$lib/server/db/repo/conversation-summaries.js');
const { registerStream, releaseStream } = await import('$lib/server/chat/streams.js');
const { subscribeServerEvents } = await import('$lib/server/events/bus.js');
const { DELETE } = await import('./+server.js');

interface Page {
	messages: { id: string; branch?: { index: number; count: number; ids: string[] } }[];
	hasOlder: boolean;
	message?: string;
}

async function del(
	user: { id: string } | null,
	id: string,
	messageId: string
): Promise<{ status: number; body: Page }> {
	const event = {
		locals: { user, session: null } as unknown as App.Locals,
		params: { id, messageId },
		request: new Request(`http://localhost/api/conversations/${id}/branch/${messageId}`, {
			method: 'DELETE'
		})
	};
	try {
		const res = await DELETE(event as never);
		return { status: res.status, body: (await res.json()) as Page };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body as Page };
		throw e;
	}
}

const u1 = { id: 'u1', role: 'user' };
const text = (t: string) => [{ type: 'text', text: t }];

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
			 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'), ('u2', 'b@b.c', 'B', 0, 0, 0, 'user')`
		)
		.run();
});

afterAll(async () => {
	await fs.rm(workspaces, { recursive: true, force: true });
});

/**
 * q → a → q2 → a2 (the original), then q edited (edit → editReply). The edit's
 * branch is shown.
 */
function seed() {
	const db = getDb();
	const conversationId = createConversation(db, 'u1').id;
	const say = (role: 'user' | 'assistant', t: string, parentId?: string | null) =>
		createMessage(db, { conversationId, role, parts: text(t), parentId }).id;
	const user = say('user', 'q');
	const reply = say('assistant', 'a');
	const followUp = say('user', 'q2');
	const followReply = say('assistant', 'a2');
	const edit = say('user', 'edited', null);
	const editReply = say('assistant', 'edited reply');
	return { conversationId, user, reply, followUp, followReply, edit, editReply };
}

describe('DELETE /api/conversations/[id]/branch/[messageId]', () => {
	it('deletes an inactive version with its whole subtree', async () => {
		const s = seed();
		const res = await del(u1, s.conversationId, s.user);
		expect(res.status).toBe(200);
		expect(res.body.messages.map((m) => m.id)).toEqual([s.edit, s.editReply]);
		expect(res.body.messages[0].branch).toBeUndefined();
		for (const id of [s.user, s.reply, s.followUp, s.followReply]) {
			expect(getMessage(getDb(), id)).toBeUndefined();
		}
		expect(listMessages(getDb(), s.conversationId).map((m) => m.id)).toEqual([s.edit, s.editReply]);
	});

	it('moves the active path to the newest remaining sibling when the shown version goes', async () => {
		const s = seed();
		const res = await del(u1, s.conversationId, s.edit);
		expect(res.status).toBe(200);
		expect(res.body.messages.map((m) => m.id)).toEqual([
			s.user,
			s.reply,
			s.followUp,
			s.followReply
		]);
		expect(getMessage(getDb(), s.editReply)).toBeUndefined();
		// nothing was reattached: the old version's tree is unchanged
		expect(getMessage(getDb(), s.reply)?.parent_id).toBe(s.user);
	});

	it('deletes a nested regenerated reply version and picks the newest remaining one', async () => {
		const db = getDb();
		const conversationId = createConversation(db, 'u1').id;
		const q = createMessage(db, { conversationId, role: 'user', parts: text('q') }).id;
		const a1 = createMessage(db, { conversationId, role: 'assistant', parts: text('a1') }).id;
		const a2 = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: text('a2'),
			parentId: q
		}).id;
		const a3 = createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: text('a3'),
			parentId: q
		}).id;
		const res = await del(u1, conversationId, a3);
		expect(res.body.messages.map((m) => m.id)).toEqual([q, a2]);
		expect(res.body.messages[1].branch).toEqual({ index: 1, count: 2, ids: [a1, a2] });
	});

	it('refuses to delete the only version', async () => {
		const s = seed();
		const res = await del(u1, s.conversationId, s.reply);
		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/only version/);
		expect(getMessage(getDb(), s.reply)).toBeDefined();
	});

	it('drops summaries anchored on deleted messages and keeps the others', async () => {
		const s = seed();
		const db = getDb();
		const keep = createSummary(db, {
			conversationId: s.conversationId,
			throughMessageId: s.edit,
			throughRowid: getMessage(db, s.edit)!.rowid,
			summaryText: 'keep',
			tokenEstimate: 1
		});
		createSummary(db, {
			conversationId: s.conversationId,
			throughMessageId: s.followUp,
			throughRowid: getMessage(db, s.followUp)!.rowid,
			summaryText: 'drop',
			tokenEstimate: 1
		});
		await del(u1, s.conversationId, s.user);
		expect(latestSummary(db, s.conversationId)?.id).toBe(keep.id);
	});

	it('removes attachment rows and files of deleted messages', async () => {
		const s = seed();
		const db = getDb();
		const stored = `${s.conversationId}/attachments/pic.png`;
		await fs.mkdir(path.join(workspaces, s.conversationId, 'attachments'), { recursive: true });
		await fs.writeFile(path.join(workspaces, stored), 'png');
		const attachment = createAttachment(db, {
			kind: 'image',
			path: stored,
			mime: 'image/png',
			sha256: 'x'
		});
		linkAttachmentsToMessage(db, s.followUp, [attachment.id]);
		expect((await del(u1, s.conversationId, s.user)).status).toBe(200);
		expect(getAttachment(db, attachment.id)).toBeUndefined();
		await expect(fs.stat(path.join(workspaces, stored))).rejects.toThrow();
	});

	it('publishes conversation.branch_changed to the owner', async () => {
		const s = seed();
		const events: unknown[] = [];
		const stop = subscribeServerEvents('u1', (_user, event) => events.push(event));
		try {
			await del(u1, s.conversationId, s.user);
		} finally {
			stop();
		}
		expect(events).toEqual([
			{ type: 'conversation.branch_changed', conversationId: s.conversationId }
		]);
	});

	it('409s while a reply is streaming', async () => {
		const s = seed();
		const controller = new AbortController();
		registerStream(s.conversationId, controller);
		try {
			expect((await del(u1, s.conversationId, s.user)).status).toBe(409);
		} finally {
			releaseStream(s.conversationId, controller);
		}
		expect(getMessage(getDb(), s.user)).toBeDefined();
	});

	it('404s for a foreign conversation, 400s for unknown or foreign messages, 401s without a user', async () => {
		const s = seed();
		const other = seed();
		expect((await del({ id: 'u2' }, s.conversationId, s.user)).status).toBe(404);
		expect((await del(u1, s.conversationId, 'nope')).status).toBe(400);
		expect((await del(u1, s.conversationId, other.user)).status).toBe(400);
		expect((await del(null, s.conversationId, s.user)).status).toBe(401);
		expect(getMessage(getDb(), other.user)).toBeDefined();
	});
});
