import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-mem-private-mcp-'));

const { createMemoryServer, memoryView } = await import('./memory.js');
const { hiddenNote } = await import('./private-items.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');
const { getDb } = await import('../../db/index.js');
const { createConversation } = await import('../../db/repo/conversations.js');
const { setUserSetting } = await import('../../db/repo/user-settings.js');
const { writeConcept, readConcept } = await import('../../memory/bundle.js');
const { bundleDir } = await import('../../memory/paths.js');
const { TurnPrivacy } = await import('../../privacy/taint.js');
const { isConversationPrivate } = await import('../../privacy/policy.js');

type Ctx = Parameters<typeof createMemoryServer>[0];

function seedUser(id: string, role: 'user' | 'admin') {
	getDb()
		.prepare(
			`INSERT OR IGNORE INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
			 VALUES (?, ?, ?, 0, 0, 0, ?)`
		)
		.run(id, `${id}@example.com`, id, role);
}

/** An untrusted caller: no trust, as the gateway and background callers are. */
function untrusted(userId: string, role: 'user' | 'admin' = 'user'): Ctx {
	seedUser(userId, role);
	return { userId, role, workspaceDir: null, documentsDir: '' };
}

/** An untrusted chat turn: a turn whose model may not see private data. */
function untrustedTurn(userId: string): Ctx {
	seedUser(userId, 'user');
	const db = getDb();
	const conversation = createConversation(db, userId, { title: 't' });
	const privacy = new TurnPrivacy(db, userId, {
		conversationId: conversation.id,
		trust: 'untrusted'
	});
	return {
		userId,
		role: 'user',
		workspaceDir: null,
		documentsDir: '',
		conversationId: conversation.id,
		privacy,
		trust: 'untrusted'
	};
}

/** A trusted turn in a fresh public conversation (optionally tainted from the start). */
function trusted(userId: string, role: 'user' | 'admin' = 'user', tainted = false) {
	seedUser(userId, role);
	const db = getDb();
	const conversation = createConversation(db, userId, { title: 't' });
	const privacy = new TurnPrivacy(db, userId, {
		conversationId: conversation.id,
		trust: 'trusted',
		tainted
	});
	const ctx: Ctx = {
		userId,
		role,
		workspaceDir: null,
		documentsDir: '',
		conversationId: conversation.id,
		privacy,
		trust: 'trusted'
	};
	return { ctx, privacy, conversationId: conversation.id };
}

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createMemoryServer(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return (await tool.execute(args, { toolCallId: 't1', messages: [] })) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
	} finally {
		await client.close();
		await server.close();
	}
}

const texts = (res: { content: Array<{ text: string }> }) => res.content.map((c) => c.text);

const save = (
	scope: 'user' | 'shared',
	userId: string,
	relPath: string,
	title: string,
	body: string,
	isPrivate = false
) =>
	writeConcept(
		getDb(),
		scope,
		userId,
		relPath,
		{ frontmatter: { title, ...(isPrivate ? { private: true } : {}) }, body },
		{ author: `user:${userId}`, userId }
	);

const fileOf = (scope: 'user' | 'shared', userId: string, relPath: string) =>
	fs.readFileSync(path.join(bundleDir(scope, userId), relPath), 'utf8');

describe('memory tools: untrusted turns', () => {
	it('hide private concepts from search and lists; a chat turn gets a note', async () => {
		await save('user', 'a1', 'pub.md', 'Pub', 'the zebra is public');
		await save('user', 'a1', 'sec.md', 'Sec', 'the zebra is secret', true);
		for (const [ctx, note] of [
			[untrustedTurn('a1'), hiddenNote()],
			// The gateway isn't told private notes exist at all.
			[untrusted('a1'), undefined]
		] as const) {
			expect(memoryView(ctx)).toBe('public');

			const found = await callTool(ctx, 'search_memory', { query: 'zebra' });
			const [json, shownNote] = texts(found);
			expect((JSON.parse(json) as Array<{ path: string }>).map((h) => h.path)).toEqual(['pub.md']);
			expect(shownNote).toBe(note);
			expect(JSON.stringify(found)).not.toContain('secret');

			const listed = await callTool(ctx, 'list_concepts', {});
			expect((JSON.parse(texts(listed)[0]) as Array<{ path: string }>).map((c) => c.path)).toEqual([
				'pub.md'
			]);
			expect(texts(listed)[1]).toBe(note);
		}
	});

	it('give the same note whether or not the query or prefix matches a private concept', async () => {
		await save('user', 'a5', 'pub.md', 'Pub', 'the heron is public');
		await save('user', 'a5', 'priv/sec.md', 'Sec', 'the kumquat is secret', true);
		const ctx = untrustedTurn('a5');
		const matching = texts(await callTool(ctx, 'search_memory', { query: 'kumquat' }));
		const other = texts(await callTool(ctx, 'search_memory', { query: 'nothingmatches' }));
		expect(matching).toEqual(['[]', hiddenNote()]);
		expect(other).toEqual(matching);
		const underPrivate = texts(await callTool(ctx, 'list_concepts', { prefix: 'priv' }));
		const underNothing = texts(await callTool(ctx, 'list_concepts', { prefix: 'nothing' }));
		expect(underPrivate).toEqual(['[]', hiddenNote()]);
		expect(underNothing).toEqual(underPrivate);
	});

	it('get no note when the user has no private concepts', async () => {
		await save('user', 'a6', 'pub.md', 'Pub', 'the heron is public');
		const ctx = untrustedTurn('a6');
		expect(texts(await callTool(ctx, 'search_memory', { query: 'heron' }))).toHaveLength(1);
		expect(texts(await callTool(ctx, 'list_concepts', {}))).toHaveLength(1);
	});

	it('answer reads, updates and deletes of a private concept like a missing one', async () => {
		await save('user', 'a2', 'sec.md', 'Sec', 'secret body', true);
		const before = fileOf('user', 'a2', 'sec.md');
		const ctx = untrusted('a2');
		const missing = texts(await callTool(ctx, 'read_concept', { path: 'nope.md' }));
		for (const [tool, args] of [
			['read_concept', { path: 'sec.md' }],
			['update_concept', { path: 'sec.md', body: 'overwritten' }],
			['delete_concept', { path: 'sec.md' }]
		] as const) {
			const res = await callTool(ctx, tool, args);
			expect(res.isError, tool).toBe(true);
			expect(texts(res), tool).toEqual(missing);
		}
		// A create answers like for any occupied path, visible or not.
		await save('user', 'a2', 'pub.md', 'Pub', 'public body');
		const occupied = texts(
			await callTool(ctx, 'create_concept', { path: 'pub.md', title: 'X', body: 'b' })
		);
		expect(occupied).toEqual(['error: concept already exists']);
		const create = await callTool(ctx, 'create_concept', {
			path: 'sec.md',
			title: 'Probe',
			body: 'overwritten'
		});
		expect(create.isError).toBe(true);
		expect(texts(create)).toEqual(occupied);
		expect(fileOf('user', 'a2', 'sec.md')).toBe(before);
	});

	it('get nothing at all under strict memory privacy, not even the note', async () => {
		await save('user', 'a3', 'pub.md', 'Pub', 'the walrus is public');
		await save('user', 'a3', 'sec.md', 'Sec', 'the walrus is secret', true);
		const ctx = untrusted('a3');
		setUserSetting(getDb(), 'a3', 'strictMemoryPrivacy', true);
		expect(memoryView(ctx)).toBe('none');
		expect(texts(await callTool(ctx, 'search_memory', { query: 'walrus' }))).toEqual(['[]']);
		expect(texts(await callTool(ctx, 'list_concepts', {}))).toEqual(['[]']);
		expect((await callTool(ctx, 'read_concept', { path: 'pub.md' })).isError).toBe(true);
		// A trusted turn is unaffected.
		expect(memoryView(trusted('a3').ctx)).toBe('all');
	});
});

describe('memory tools: trusted turns', () => {
	it('taint the turn (and make its chat private) when they return a private concept', async () => {
		await save('user', 'b1', 'sec.md', 'Sec', 'secret body', true);
		const { ctx, privacy, conversationId } = trusted('b1');
		const res = await callTool(ctx, 'read_concept', { path: 'sec.md' });
		expect(res.isError).toBeFalsy();
		expect(texts(res)[0]).toContain('secret body');
		expect(privacy.tainted).toBe(true);
		expect(isConversationPrivate(getDb(), conversationId)).toBe(true);
	});

	it('stay untainted when nothing private comes back', async () => {
		await save('user', 'b2', 'pub.md', 'Pub', 'the heron is public');
		await save('user', 'b2', 'sec.md', 'Sec', 'nothing to see', true);
		const { ctx, privacy } = trusted('b2');
		await callTool(ctx, 'search_memory', { query: 'heron' });
		expect(privacy.tainted).toBe(false);
	});

	it('force private: true on writes from a tainted context, and never clear it', async () => {
		await save('user', 'b3', 'pub.md', 'Pub', 'public body');
		const { ctx } = trusted('b3', 'user', true);
		const created = await callTool(ctx, 'create_concept', {
			path: 'new.md',
			title: 'New',
			body: 'from a private chat'
		});
		expect(texts(created)[0]).toBe('created new.md (private)');
		expect(fileOf('user', 'b3', 'new.md')).toMatch(/^private: true$/m);

		await callTool(ctx, 'update_concept', { path: 'pub.md', body: 'now with private data' });
		expect((await readConcept('user', 'b3', 'pub.md'))?.frontmatter.private).toBe(true);

		// An untainted trusted turn editing a private concept keeps the flag.
		await save('user', 'b3', 'sec.md', 'Sec', 'secret', true);
		await callTool(trusted('b3').ctx, 'update_concept', { path: 'sec.md', body: 'edited' });
		expect((await readConcept('user', 'b3', 'sec.md'))?.frontmatter.private).toBe(true);
	});
});

describe('memory tools: private shared concepts', () => {
	it("are readable by another user's trusted turn, which they taint", async () => {
		await save('shared', 'admin1', 'house/alarm.md', 'Alarm', 'code 4711', true);
		const b = trusted('userB');
		const res = await callTool(b.ctx, 'read_concept', { path: 'house/alarm.md', scope: 'shared' });
		expect(texts(res)[0]).toContain('code 4711');
		expect(b.privacy.tainted).toBe(true);

		const hidden = await callTool(untrusted('userB'), 'read_concept', {
			path: 'house/alarm.md',
			scope: 'shared'
		});
		expect(hidden.isError).toBe(true);
		expect(JSON.stringify(hidden)).not.toContain('4711');
	});

	it("can't have their flag changed by a non-admin", async () => {
		await save('shared', 'admin1', 'house/wifi.md', 'Wifi', 'pw hunter2', true);
		const res = await callTool(trusted('userC').ctx, 'update_concept', {
			path: 'house/wifi.md',
			scope: 'shared',
			body: 'public now?'
		});
		expect(res.isError).toBe(true);
		expect(texts(res)[0]).toMatch(/admin/);
		expect((await readConcept('shared', 'admin1', 'house/wifi.md'))?.frontmatter.private).toBe(
			true
		);
	});
});
