/**
 * The data tools and private data: untrusted turns never see private chats,
 * documents or agent runs (filtered, with a count at most), trusted turns do
 * and are tainted by them before the result returns, and writes from a
 * private context stay private.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { getDb } = await import('../../db/index.js');
const { createConversation } = await import('../../db/repo/conversations.js');
const { createMessage } = await import('../../db/repo/messages.js');
const { createAgent } = await import('../../db/repo/agents.js');
const { createAgentRun, finishAgentRun } = await import('../../db/repo/agent-runs.js');
const { isConversationPrivate } = await import('../../privacy/policy.js');
const { TurnPrivacy } = await import('../../privacy/taint.js');
const { BLOCKED_PREFIX } = await import('../../privacy/guard.js');
const { CANARY, markConversationPrivate, seedPrivacyFixture, setRole } =
	await import('../../privacy/fixtures.js');
const { prepareAgentCreate, PRIVATE_AGENT_MODEL_ERROR } = await import('../../agentInput.js');
const { createChatSearchServer } = await import('./chat-search.js');
const { createFsServer } = await import('./fs.js');
const { createAgentsServer, PRIVATE_RUN_NOTE } = await import('./agents.js');
const { createCodingServer } = await import('./coding.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

type Ctx = Parameters<typeof createFsServer>[0];
type Trust = 'trusted' | 'untrusted';

const db = getDb();
const fx = seedPrivacyFixture(db);
const userId = fx.userId;

let documentsDir: string;
let workspaceDir: string;

beforeAll(() => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-private-'));
	documentsDir = path.join(base, 'docs');
	workspaceDir = path.join(base, 'ws');
	fs.mkdirSync(path.join(documentsDir, 'private'), { recursive: true });
	fs.mkdirSync(workspaceDir, { recursive: true });
	fs.writeFileSync(path.join(documentsDir, 'notes.md'), 'public notes\n');
	fs.writeFileSync(path.join(documentsDir, 'private', 'secret.md'), `${CANARY}\n`);
});

/** A chat the tool is called from, and its turn's privacy. */
function turn(trust: Trust, opts: { private?: boolean } = {}) {
	const conversation = createConversation(db, userId, {
		title: 'calling chat',
		private: opts.private ?? false
	});
	const privacy = new TurnPrivacy(db, userId, { conversationId: conversation.id, trust });
	const ctx: Ctx = {
		userId,
		role: 'user',
		workspaceDir,
		documentsDir,
		conversationId: conversation.id,
		privacy,
		trust
	};
	return { ctx, privacy, conversationId: conversation.id };
}

/** The MCP gateway's context: no turn, no trust. */
const gatewayCtx = (): Ctx => ({ userId, role: 'user', workspaceDir: null, documentsDir });

async function call(
	create: (ctx: Ctx) => McpServer,
	ctx: Ctx,
	name: string,
	args: Record<string, unknown>
) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = create(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tool = (await client.tools())[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		const res = (await tool.execute(args, { toolCallId: 't1', messages: [] })) as {
			isError?: boolean;
			content?: Array<{ text?: string }>;
		};
		return { isError: res.isError === true, text: res.content?.[0]?.text ?? '' };
	} finally {
		await client.close();
		await server.close();
	}
}

function chat(title: string, text: string, opts: { private?: boolean } = {}) {
	const c = createConversation(db, userId, { title, private: opts.private ?? false });
	createMessage(db, { conversationId: c.id, role: 'user', parts: [{ type: 'text', text }] });
	return c.id;
}

describe('chat search', () => {
	let publicId: string;
	let privateTitleId: string;
	let privateBodyId: string;
	beforeAll(() => {
		publicId = chat('zebra public', 'about zebras and okapis');
		// Private matches rank first, so a filter after LIMIT would leave nothing.
		privateTitleId = chat('zebra zebra secret', `${CANARY} zebra zebra`, { private: true });
		privateBodyId = chat('other', `${CANARY} zebra zebra zebra`, { private: true });
	});

	it('hides private chats from an untrusted turn, before the limit, with a count', async () => {
		for (const ctx of [turn('untrusted').ctx, gatewayCtx()]) {
			const res = await call(createChatSearchServer, ctx, 'search_chats', {
				query: 'zebra',
				limit: 1
			});
			expect(res.isError).toBe(false);
			const [json, note] = res.text.split('\n');
			expect(JSON.parse(json).map((r: { id: string }) => r.id)).toEqual([publicId]);
			expect(note).toBe(
				'2 private results hidden: this chat can reach a model that may not see private data'
			);
			expect(res.text).not.toContain(CANARY);
			expect(res.text).not.toContain('secret');
			expect(res.text).not.toContain(privateTitleId);
		}
	});

	it('hides private chats from an untrusted "since" listing', async () => {
		const res = await call(createChatSearchServer, gatewayCtx(), 'search_chats', { since: '0' });
		const ids = JSON.parse(res.text.split('\n')[0]).map((r: { id: string }) => r.id);
		expect(ids).toContain(publicId);
		expect(ids).not.toContain(privateBodyId);
		expect(res.text).toMatch(/\d+ private results? hidden/);
	});

	it('returns private chats to a trusted turn and taints it', async () => {
		const { ctx, privacy, conversationId } = turn('trusted');
		const res = await call(createChatSearchServer, ctx, 'search_chats', { query: 'zebra' });
		const rows = JSON.parse(res.text) as { id: string; private?: boolean }[];
		expect(rows.map((r) => r.id)).toEqual(
			expect.arrayContaining([publicId, privateTitleId, privateBodyId])
		);
		expect(rows.find((r) => r.id === privateTitleId)?.private).toBe(true);
		expect(privacy.tainted).toBe(true);
		expect(isConversationPrivate(db, conversationId)).toBe(true);
	});

	it("doesn't taint a trusted turn when nothing private is returned", async () => {
		const { ctx, privacy, conversationId } = turn('trusted');
		const res = await call(createChatSearchServer, ctx, 'search_chats', { query: 'okapis' });
		expect(JSON.parse(res.text).map((r: { id: string }) => r.id)).toEqual([publicId]);
		expect(privacy.tainted).toBe(false);
		expect(isConversationPrivate(db, conversationId)).toBe(false);
	});

	it('read_chat: a private chat is "not found" for an untrusted turn', async () => {
		const missing = await call(createChatSearchServer, gatewayCtx(), 'read_chat', {
			conversationId: 'nope'
		});
		for (const ctx of [turn('untrusted').ctx, gatewayCtx()]) {
			const res = await call(createChatSearchServer, ctx, 'read_chat', {
				conversationId: privateBodyId
			});
			expect(res).toEqual(missing);
		}
	});

	it('read_chat: a private subagent\'s transcript is "not found" for an untrusted turn', async () => {
		const parent = createConversation(db, userId, { title: 'parent', private: true });
		const sub = createConversation(db, userId, {
			kind: 'agent-run',
			title: 'Subagent: x',
			subagentOf: parent.id,
			private: true
		});
		createMessage(db, {
			conversationId: sub.id,
			role: 'user',
			parts: [{ type: 'text', text: CANARY }]
		});
		const res = await call(createChatSearchServer, gatewayCtx(), 'read_chat', {
			conversationId: sub.id
		});
		expect(res).toEqual({ isError: true, text: 'error: conversation not found' });
		const trusted = turn('trusted');
		const read = await call(createChatSearchServer, trusted.ctx, 'read_chat', {
			conversationId: sub.id
		});
		expect(read.text).toContain(CANARY);
		expect(trusted.privacy.tainted).toBe(true);
	});

	it('read_chat: a trusted turn reads it, and the chat is private before the result returns', async () => {
		const { ctx, conversationId } = turn('trusted');
		const events: string[] = [];
		const privacy = ctx.privacy as InstanceType<typeof TurnPrivacy>;
		const markTainted = privacy.markTainted.bind(privacy);
		privacy.markTainted = (reason: string) => {
			markTainted(reason);
			events.push(`tainted:${isConversationPrivate(db, conversationId)}`);
		};
		const res = await call(createChatSearchServer, ctx, 'read_chat', {
			conversationId: privateBodyId
		});
		events.push('result');
		expect(res.text).toContain(CANARY);
		expect(events).toEqual(['tainted:true', 'result']);
	});
});

describe('documents/private', () => {
	it('does not exist for an untrusted turn', async () => {
		for (const ctx of [turn('untrusted').ctx, gatewayCtx()]) {
			const read = (p: string) =>
				call(createFsServer, ctx, 'fs_read', { scope: 'documents', path: p });
			const hidden = await read('private/secret.md');
			const missing = await read('private/missing.md');
			expect(hidden.isError).toBe(true);
			expect(hidden.text).toBe(missing.text.replace('missing.md', 'secret.md'));
			expect(hidden.text).not.toContain(CANARY);

			const ls = await call(createFsServer, ctx, 'fs_ls', { scope: 'documents' });
			expect(ls.text.split('\n')).toEqual(['notes.md']);
			const lsPrivate = await call(createFsServer, ctx, 'fs_ls', {
				scope: 'documents',
				path: 'private'
			});
			expect(lsPrivate).toEqual({ isError: true, text: 'error: not a directory: private' });

			const glob = await call(createFsServer, ctx, 'fs_glob', {
				scope: 'documents',
				pattern: '**/*.md'
			});
			expect(JSON.parse(glob.text)).toEqual(['notes.md']);
			const grep = await call(createFsServer, ctx, 'fs_grep', {
				scope: 'documents',
				pattern: 'CANARY'
			});
			expect(grep).toEqual({ isError: false, text: '' });
		}
	});

	it('is readable by a trusted turn, which it taints', async () => {
		const { ctx, privacy, conversationId } = turn('trusted');
		const res = await call(createFsServer, ctx, 'fs_read', {
			scope: 'documents',
			path: 'private/secret.md'
		});
		expect(res.text).toContain(CANARY);
		expect(privacy.tainted).toBe(true);
		expect(isConversationPrivate(db, conversationId)).toBe(true);
	});

	it("doesn't taint a trusted turn that reads shared documents", async () => {
		const { ctx, privacy } = turn('trusted');
		const ls = await call(createFsServer, ctx, 'fs_ls', { scope: 'documents' });
		expect(ls.text.split('\n')).toEqual(['private/', 'notes.md']);
		await call(createFsServer, ctx, 'fs_read', { scope: 'documents', path: 'notes.md' });
		const grep = await call(createFsServer, ctx, 'fs_grep', {
			scope: 'documents',
			pattern: 'public'
		});
		expect(grep.text).toBe('notes.md:1:public notes');
		expect(privacy.tainted).toBe(false);
	});

	it('a trusted grep that hits a private file taints', async () => {
		const { ctx, privacy } = turn('trusted');
		const grep = await call(createFsServer, ctx, 'fs_grep', {
			scope: 'documents',
			pattern: 'CANARY'
		});
		expect(grep.text).toContain('private/secret.md:1:');
		expect(privacy.tainted).toBe(true);
	});

	it('redirects document writes from a private chat to documents/private', async () => {
		const { ctx } = turn('trusted', { private: true });
		const write = await call(createFsServer, ctx, 'fs_write', {
			scope: 'documents',
			path: 'draft.md',
			content: CANARY
		});
		expect(write.text).toBe(
			'created private/draft.md: saved to private/draft.md instead of draft.md because this chat is private'
		);
		expect(fs.existsSync(path.join(documentsDir, 'draft.md'))).toBe(false);
		expect(fs.readFileSync(path.join(documentsDir, 'private', 'draft.md'), 'utf-8')).toBe(CANARY);

		// An edit starts from the shared file and saves a private copy; the shared one stays.
		const edit = await call(createFsServer, ctx, 'fs_edit', {
			scope: 'documents',
			path: 'notes.md',
			old: 'public',
			new: CANARY
		});
		expect(edit.text).toContain('saved to private/notes.md');
		expect(fs.readFileSync(path.join(documentsDir, 'notes.md'), 'utf-8')).toBe('public notes\n');
		expect(fs.readFileSync(path.join(documentsDir, 'private', 'notes.md'), 'utf-8')).toBe(
			`${CANARY} notes\n`
		);

		const mkdir = await call(createFsServer, ctx, 'fs_mkdir', { scope: 'documents', path: 'dir' });
		expect(mkdir.text).toContain('saved to private/dir');
		expect(fs.existsSync(path.join(documentsDir, 'dir'))).toBe(false);

		// The workspace is private through its conversation: no redirect.
		const ws = await call(createFsServer, ctx, 'fs_write', {
			scope: 'workspace',
			path: 'out.md',
			content: CANARY
		});
		expect(ws.text).toBe('created out.md');
		expect(fs.existsSync(path.join(workspaceDir, 'out.md'))).toBe(true);
	});

	it('writes from a public chat stay where they were asked for', async () => {
		const { ctx } = turn('trusted');
		const write = await call(createFsServer, ctx, 'fs_write', {
			scope: 'documents',
			path: 'shared.md',
			content: 'hello'
		});
		expect(write.text).toBe('created shared.md');
		expect(fs.existsSync(path.join(documentsDir, 'shared.md'))).toBe(true);
	});
});

describe('private agents', () => {
	it('must use a trusted model', async () => {
		const { ctx } = turn('trusted');
		const base = { name: 'p', systemPrompt: 'x', triggerType: 'manual', private: true };
		const untrusted = await call(createAgentsServer, ctx, 'create_agent', {
			...base,
			...fx.untrusted
		});
		expect(untrusted).toEqual({ isError: true, text: `error: ${PRIVATE_AGENT_MODEL_ERROR}` });

		const created = await call(createAgentsServer, ctx, 'create_agent', {
			...base,
			...fx.trusted
		});
		expect(created.isError).toBe(false);
		const agent = JSON.parse(created.text) as { id: string; private: boolean };
		expect(agent.private).toBe(true);
		const got = await call(createAgentsServer, ctx, 'get_agent', { agentId: agent.id });
		expect(JSON.parse(got.text).private).toBe(true);
		const listed = await call(createAgentsServer, ctx, 'list_agents', {});
		expect(JSON.parse(listed.text).find((a: { id: string }) => a.id === agent.id).private).toBe(
			true
		);

		// Moving it to an untrusted model is refused.
		const moved = await call(createAgentsServer, ctx, 'update_agent', {
			agentId: agent.id,
			...fx.untrusted
		});
		expect(moved).toEqual({ isError: true, text: `error: ${PRIVATE_AGENT_MODEL_ERROR}` });
	});

	it('without a model, needs a trusted default chat model', () => {
		const input = { name: 'p', systemPrompt: 'x', triggerType: 'manual' as const, private: true };
		setRole(db, 'chat', fx.untrusted);
		expect(prepareAgentCreate(db, input)).toEqual({ ok: false, error: PRIVATE_AGENT_MODEL_ERROR });
		setRole(db, 'chat', fx.trusted);
		expect(prepareAgentCreate(db, input).ok).toBe(true);
	});

	it('coding agents cannot be private', () => {
		const res = prepareAgentCreate(db, {
			name: 'c',
			systemPrompt: 'x',
			triggerType: 'manual',
			private: true,
			codingTarget: {
				environmentId: 'e',
				projectId: 'p',
				providerInstanceId: 'i',
				model: 'm',
				autonomy: 'full-access' as never,
				workspaceMode: 'local'
			}
		});
		expect(res.ok).toBe(false);
	});

	describe('a private run', () => {
		function privateRun() {
			const agent = createAgent(db, userId, {
				name: 'secret agent',
				systemPrompt: 'x',
				triggerType: 'manual',
				private: true,
				...fx.trusted
			});
			const conversation = createConversation(db, userId, {
				kind: 'agent-run',
				agentId: agent.id,
				private: true
			});
			createMessage(db, {
				conversationId: conversation.id,
				role: 'assistant',
				parts: [{ type: 'text', text: `The answer is ${CANARY}` }]
			});
			const run = createAgentRun(db, {
				agentId: agent.id,
				userId,
				trigger: 'manual',
				conversationId: conversation.id
			});
			finishAgentRun(db, run.id, 'success');
			return run.id;
		}

		it('reaches an untrusted caller only as "private, open it in Chatty"', async () => {
			const runId = privateRun();
			for (const ctx of [turn('untrusted').ctx, gatewayCtx()]) {
				const res = await call(createAgentsServer, ctx, 'get_agent_run', { runId });
				expect(res.text).not.toContain(CANARY);
				const body = JSON.parse(res.text);
				expect(body.note).toBe(PRIVATE_RUN_NOTE);
				expect(body.run.id).toBe(runId);
				expect(body.result).toBeNull();
			}
		});

		it('reaches a trusted caller and taints it', async () => {
			const runId = privateRun();
			const { ctx, privacy, conversationId } = turn('trusted');
			const res = await call(createAgentsServer, ctx, 'get_agent_run', { runId });
			expect(JSON.parse(res.text).result).toContain(CANARY);
			expect(privacy.tainted).toBe(true);
			expect(isConversationPrivate(db, conversationId)).toBe(true);
		});
	});
});

describe('coding proposals', () => {
	it('are refused from a private chat', async () => {
		const { ctx, conversationId } = turn('trusted');
		markConversationPrivate(db, conversationId);
		const res = await call(createCodingServer, ctx, 'propose_coding_task', { prompt: CANARY });
		expect(res.isError).toBe(true);
		expect(res.text).toContain(BLOCKED_PREFIX);
	});
});
