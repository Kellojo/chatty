/**
 * Making chats private (PR 7): new chats under `privateByDefault`, the "Make
 * private" dialog's title placeholder and derived concepts, the chat list's
 * bulk action, and marking a list of concepts private.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.PRIVATE_DATA_ENABLED = 'true';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-make-private-'));

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createConversation, getConversation } =
	await import('$lib/server/db/repo/conversations.js');
const { createCodingConversation } = await import('$lib/server/db/repo/coding-conversations.js');
const { createCodingEnvironment } = await import('$lib/server/db/repo/coding-environments.js');
const { createMessage } = await import('$lib/server/db/repo/messages.js');
const { setUserSetting } = await import('$lib/server/db/repo/user-settings.js');
const { readConcept, writeConcept } = await import('$lib/server/memory/bundle.js');
const { seedPrivacyFixture } = await import('$lib/server/privacy/fixtures.js');
const { POST: createChat } = await import('../+server.js');
const { PATCH } = await import('../[id]/+server.js');
const { GET: derivedGet } = await import('../[id]/derived-concepts/+server.js');
const { POST: bulkPrivate } = await import('./+server.js');
const { POST: memoryPrivate } = await import('../../memory/private/+server.js');

type Db = ReturnType<typeof getDb>;

async function call<T = Record<string, unknown>>(
	handler: (event: never) => Response | Promise<Response>,
	init: { user?: { id: string; role?: string }; params?: Record<string, string>; body?: unknown }
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/conversations');
	const event = {
		locals: { user: init.user ?? null, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, {
			method: init.body === undefined ? 'GET' : 'POST',
			headers: { 'content-type': 'application/json' },
			body: init.body === undefined ? undefined : JSON.stringify(init.body)
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

const user = { id: 'u1', role: 'user' };
let db: Db;

function untrustAll() {
	db.prepare('UPDATE providers SET allow_private = 0').run();
}

beforeEach(() => {
	closeDb();
	db = getDb();
	seedPrivacyFixture(db);
	db.prepare(`UPDATE "user" SET role = 'user' WHERE id = 'u1'`).run();
});

describe('privateByDefault', () => {
	type Created = { conversation: { id: string; private: boolean } };

	it('starts new chats private when the setting is on', async () => {
		setUserSetting(db, 'u1', 'privateByDefault', true);
		const res = await call<Created>(createChat, { user, body: {} });
		expect(res.status).toBe(201);
		expect(res.body.conversation.private).toBe(true);
	});

	it('leaves chats public without the setting', async () => {
		const res = await call<Created>(createChat, { user, body: {} });
		expect(res.body.conversation.private).toBe(false);
	});

	it('lets the new-chat lock turn it off for one chat', async () => {
		setUserSetting(db, 'u1', 'privateByDefault', true);
		const res = await call<Created>(createChat, { user, body: { private: false } });
		expect(res.body.conversation.private).toBe(false);
	});

	it('does not apply (nor fail) while no provider is trusted', async () => {
		setUserSetting(db, 'u1', 'privateByDefault', true);
		untrustAll();
		const res = await call<Created>(createChat, { user, body: {} });
		expect(res.status).toBe(201);
		expect(res.body.conversation.private).toBe(false);
	});
});

describe('PATCH replaceTitle', () => {
	type Patched = { conversation: { title: string; private: boolean } };

	it('replaces the title with a placeholder when making a chat private', async () => {
		const c = createConversation(db, 'u1', { title: 'My tax return' });
		const res = await call<Patched>(PATCH, {
			user,
			params: { id: c.id },
			body: { private: true, replaceTitle: true }
		});
		expect(res.status).toBe(200);
		expect(res.body.conversation.private).toBe(true);
		expect(res.body.conversation.title).toMatch(/^Private chat · /);
		expect(getConversation(db, 'u1', c.id)?.title).toBe(res.body.conversation.title);
	});

	it('keeps the title without it', async () => {
		const c = createConversation(db, 'u1', { title: 'My tax return' });
		const res = await call<Patched>(PATCH, {
			user,
			params: { id: c.id },
			body: { private: true }
		});
		expect(res.body.conversation.title).toBe('My tax return');
	});

	it('only takes replaceTitle together with private: true', async () => {
		const c = createConversation(db, 'u1', { title: 'Keep me' });
		const res = await call(PATCH, { user, params: { id: c.id }, body: { replaceTitle: true } });
		expect(res.status).toBe(400);
		expect(getConversation(db, 'u1', c.id)?.title).toBe('Keep me');
	});
});

describe('derived concepts', () => {
	type Listed = { concepts: { scope: string; path: string; title: string; private: boolean }[] };

	const write = (rel: string, title: string, conversationId: string | null, scope = 'user') =>
		writeConcept(
			db,
			scope as 'user' | 'shared',
			'u1',
			rel,
			{ frontmatter: { title }, body: 'x' },
			{ author: 'agent:memory', userId: 'u1', conversationId }
		);

	const readChatCall = (conversationId: string) => ({
		type: 'dynamic-tool',
		toolName: 'read_chat',
		toolCallId: `t-${conversationId}`,
		state: 'output-available',
		input: { conversationId },
		output: { content: [] }
	});

	it('lists concepts written by runs (and their subagents) after reading the chat', async () => {
		const chat = createConversation(db, 'u1', { title: 'Secret plans' });
		const other = createConversation(db, 'u1', { title: 'Other' });
		const run = createConversation(db, 'u1', { kind: 'agent-run', title: 'memory run' });
		const sub = createConversation(db, 'u1', {
			kind: 'agent-run',
			title: 'sub',
			subagentOf: run.id
		});
		const unrelated = createConversation(db, 'u1', { kind: 'agent-run', title: 'other run' });
		// Written by the run before it read the chat: not from it.
		await write('early.md', 'Early', run.id);
		await new Promise((r) => setTimeout(r, 5));
		createMessage(db, {
			conversationId: sub.id,
			role: 'assistant',
			parts: [readChatCall(chat.id)]
		});
		createMessage(db, {
			conversationId: unrelated.id,
			role: 'assistant',
			// Mentions the id, but reads another chat.
			parts: [{ type: 'text', text: chat.id }, readChatCall(other.id)]
		});
		await new Promise((r) => setTimeout(r, 5));
		await write('people/sam.md', 'Sam', run.id);
		await write('house/alarm.md', 'Alarm code', run.id, 'shared');
		await write('ignored.md', 'Ignored', unrelated.id);
		await write('own.md', 'Written in the chat', chat.id);

		const res = await call<Listed>(derivedGet, { user, params: { id: chat.id } });
		expect(res.status).toBe(200);
		expect(res.body.concepts).toEqual([
			{ scope: 'user', path: 'own.md', title: 'Written in the chat', private: false },
			{ scope: 'user', path: 'people/sam.md', title: 'Sam', private: false },
			{ scope: 'shared', path: 'house/alarm.md', title: 'Alarm code', private: false }
		]);
	});

	it("is 404 for someone else's chat", async () => {
		const c = createConversation(db, 'u1', { title: 'Mine' });
		const res = await call(derivedGet, { user: { id: 'u2' }, params: { id: c.id } });
		expect(res.status).toBe(404);
	});

	it('marks a list of concepts private', async () => {
		await write('a.md', 'A', null);
		await write('b.md', 'B', null);
		const res = await call<{ updated: number }>(memoryPrivate, {
			user,
			body: { paths: ['a.md', 'missing.md'], private: true }
		});
		expect(res.body.updated).toBe(1);
		expect((await readConcept('user', 'u1', 'a.md'))?.frontmatter.private).toBe(true);
		expect((await readConcept('user', 'u1', 'b.md'))?.frontmatter.private).toBeUndefined();
	});

	it('keeps shared concepts admin-only and refuses both prefix and paths', async () => {
		const shared = await call(memoryPrivate, {
			user,
			body: { scope: 'shared', paths: ['house/alarm.md'], private: true }
		});
		expect(shared.status).toBe(403);
		const both = await call(memoryPrivate, {
			user,
			body: { prefix: '', paths: ['a.md'], private: true }
		});
		expect(both.status).toBe(400);
	});
});

describe('bulk Make private', () => {
	type Bulk = { updated: string[]; skipped: { id: string; reason: string }[] };

	it('makes the chats private and skips coding, missing and already private ones', async () => {
		const a = createConversation(db, 'u1', { title: 'A' });
		const b = createConversation(db, 'u1', { title: 'B', private: true });
		const coding = createConversation(db, 'u1', { title: 'Task' });
		const env = createCodingEnvironment(db, 'u1', {
			name: 'T3',
			baseUrl: 'http://t3.test',
			token: 'token'
		});
		createCodingConversation(db, {
			conversationId: coding.id,
			environmentId: env.id,
			projectId: 'p1',
			projectTitle: 'Project',
			providerInstanceId: 'codex',
			model: 'gpt',
			runtimeMode: 'auto',
			workspaceMode: 'worktree',
			baseBranch: null
		});
		const res = await call<Bulk>(bulkPrivate, {
			user,
			body: { ids: [a.id, b.id, coding.id, 'nope'], replaceTitle: true }
		});
		expect(res.status).toBe(200);
		expect(res.body.updated).toEqual([a.id]);
		expect(res.body.skipped).toEqual([
			{ id: b.id, reason: 'already-private' },
			{ id: coding.id, reason: 'coding' },
			{ id: 'nope', reason: 'not-found' }
		]);
		expect(getConversation(db, 'u1', a.id)).toMatchObject({ private: 1 });
		expect(getConversation(db, 'u1', a.id)?.title).toMatch(/^Private chat · /);
		expect(getConversation(db, 'u1', b.id)?.title).toBe('B');
		expect(getConversation(db, 'u1', coding.id)).toMatchObject({ private: 0, title: 'Task' });
	});

	it('refuses while no provider is trusted', async () => {
		untrustAll();
		const a = createConversation(db, 'u1', { title: 'A' });
		const res = await call(bulkPrivate, { user, body: { ids: [a.id] } });
		expect(res.status).toBe(409);
		expect(getConversation(db, 'u1', a.id)).toMatchObject({ private: 0 });
	});

	it("never touches another user's chats", async () => {
		const a = createConversation(db, 'u1', { title: 'A' });
		const res = await call<Bulk>(bulkPrivate, { user: { id: 'u2' }, body: { ids: [a.id] } });
		expect(res.body.skipped).toEqual([{ id: a.id, reason: 'not-found' }]);
		expect(getConversation(db, 'u1', a.id)).toMatchObject({ private: 0 });
	});
});
