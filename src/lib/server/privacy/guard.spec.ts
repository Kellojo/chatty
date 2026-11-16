import { beforeEach, describe, expect, it } from 'vitest';
import type { Tool } from 'ai';

process.env.DATABASE_PATH = ':memory:';

const { closeDb, getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { createAgent } = await import('../db/repo/agents.js');
const { wrapMcpTools } = await import('../tools/wrap.js');
const { assertToolAllowed, BLOCKED_PREFIX, hiddenWhenTainted } = await import('./guard.js');
const { PrivateDataBlockedError } = await import('./policy.js');
const { TurnPrivacy } = await import('./taint.js');
const { seedPrivacyFixture, setRole } = await import('./fixtures.js');

let fx: ReturnType<typeof seedPrivacyFixture>;
beforeEach(() => {
	closeDb();
	fx = seedPrivacyFixture(getDb());
});

const builtin = (name: string) => ({ name, builtin: 1 });
const tainted = { tainted: true };

describe('tool guard', () => {
	it('refuses egress and persist tools once tainted, allows the rest', () => {
		const db = getDb();
		const call =
			(server: string, tool: string, p = tainted) =>
			() =>
				assertToolAllowed(db, builtin(server), tool, {}, p);
		expect(call('webfetch', 'fetch')).toThrow(PrivateDataBlockedError);
		expect(call('webfetch', 'fetch')).toThrow(BLOCKED_PREFIX);
		expect(call('fs', 'fs_curl')).toThrow(PrivateDataBlockedError);
		expect(call('weather', 'get_weather')).toThrow(PrivateDataBlockedError);
		expect(call('websearch', 'web_search')).toThrow(PrivateDataBlockedError);
		expect(call('skills', 'create_skill')).toThrow(PrivateDataBlockedError);
		expect(call('coding', 'propose_coding_task')).toThrow(PrivateDataBlockedError);
		expect(call('chat-search', 'read_chat')).not.toThrow();
		expect(call('fs', 'fs_read')).not.toThrow();
		expect(call('webfetch', 'fetch', { tainted: false })).not.toThrow();
	});

	it('refuses external servers unless allowed in private chats', () => {
		const db = getDb();
		expect(() =>
			assertToolAllowed(db, { name: 'groceries', builtin: 0, allow_private: 0 }, 'add', {}, tainted)
		).toThrow(PrivateDataBlockedError);
		expect(() =>
			assertToolAllowed(db, { name: 'groceries', builtin: 0, allow_private: 1 }, 'add', {}, tainted)
		).not.toThrow();
	});

	it('only lets a tainted context create and start private agents on trusted models', () => {
		const db = getDb();
		const agents = builtin('agents');
		const create = (input: object) => () =>
			assertToolAllowed(db, agents, 'create_agent', input, tainted);
		expect(create({ name: 'x', ...fx.trusted })).toThrow(PrivateDataBlockedError);
		expect(create({ name: 'x', private: true, ...fx.untrusted })).toThrow(PrivateDataBlockedError);
		expect(create({ name: 'x', private: true, ...fx.trusted })).not.toThrow();
		// No model: the default chat model decides.
		expect(create({ name: 'x', private: true })).toThrow(PrivateDataBlockedError);
		setRole(db, 'chat', fx.trusted);
		expect(create({ name: 'x', private: true })).not.toThrow();

		const agent = createAgent(db, fx.userId, {
			name: 'a',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		const start = () =>
			assertToolAllowed(db, agents, 'start_agent', { agentId: agent.id }, tainted);
		expect(start).toThrow(PrivateDataBlockedError);
		db.prepare('UPDATE agents SET private = 1 WHERE id = ?').run(agent.id);
		expect(start).not.toThrow();
		expect(hiddenWhenTainted(db, agents, 'start_agent')).toBe(false);
		expect(hiddenWhenTainted(db, builtin('webfetch'), 'fetch')).toBe(true);
	});

	it('checks every wrapped call, so a tool loaded later is refused too', async () => {
		const db = getDb();
		const c = createConversation(db, fx.userId, { private: false });
		const privacy = new TurnPrivacy(db, fx.userId, { conversationId: c.id, trust: 'trusted' });
		let ran = 0;
		const tools = wrapMcpTools(
			{ fetch: { execute: async () => ++ran } as unknown as Tool },
			'webfetch',
			{ guard: (tool, input) => assertToolAllowed(db, builtin('webfetch'), tool, input, privacy) }
		);
		const run = () => tools.fetch.execute!({}, { toolCallId: 't', messages: [] } as never);
		await run();
		expect(ran).toBe(1);
		privacy.markTainted('read a private note');
		await expect(run()).rejects.toThrow(BLOCKED_PREFIX);
		expect(ran).toBe(1);
	});
});

describe('turn taint', () => {
	it('announces the promotion once, and only for a chat that was public', () => {
		const db = getDb();
		const open = createConversation(db, fx.userId, { private: false });
		const privacy = new TurnPrivacy(db, fx.userId, { conversationId: open.id, trust: 'trusted' });
		const seen: string[] = [];
		privacy.onPromoted = (reason) => seen.push(reason);
		privacy.markTainted('a private note');
		privacy.markTainted('a private chat');
		expect(seen).toEqual(['a private note']);

		const already = createConversation(db, fx.userId, { private: true });
		const quiet = new TurnPrivacy(db, fx.userId, { conversationId: already.id, trust: 'trusted' });
		quiet.onPromoted = (reason) => seen.push(reason);
		quiet.markTainted('a private note');
		expect(seen).toEqual(['a private note']);
	});

	it('writes the private flag before markTainted returns', () => {
		const db = getDb();
		const c = createConversation(db, fx.userId, { private: false });
		const privacy = new TurnPrivacy(db, fx.userId, { conversationId: c.id, trust: 'trusted' });
		expect(privacy.tainted).toBe(false);
		privacy.markTainted('read a private note');
		const row = db.prepare('SELECT private FROM conversations WHERE id = ?').get(c.id) as {
			private: number;
		};
		expect(row.private).toBe(1);
		expect(privacy.tainted).toBe(true);
	});

	it('starts tainted in a private chat and refuses to taint an untrusted turn', () => {
		const db = getDb();
		const c = createConversation(db, fx.userId, { private: true });
		expect(new TurnPrivacy(db, fx.userId, { conversationId: c.id, trust: 'trusted' }).tainted).toBe(
			true
		);
		const open = createConversation(db, fx.userId, { private: false });
		const untrusted = new TurnPrivacy(db, fx.userId, {
			conversationId: open.id,
			trust: 'untrusted'
		});
		expect(() => untrusted.markTainted('x')).toThrow();
		const row = db.prepare('SELECT private FROM conversations WHERE id = ?').get(open.id) as {
			private: number;
		};
		expect(row.private).toBe(0);
	});
});
