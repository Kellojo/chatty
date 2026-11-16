/**
 * Egress canary rows for private memory (PR 6): memory tools in untrusted
 * turns (user and shared concepts), the MCP gateway, and the memory agents'
 * passes (extraction, cleanup). See canary.spec.ts for how the harness works.
 *
 * The memory agents' turns are captured instead of run (the fake provider
 * can't call tools): each row builds the pass's tools the way the chat engine
 * does from the run's turn limits, and drives them as the model would.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ConversationRow } from '../db/repo/conversations.js';
import type { ChatTurnOptions } from '../chat/service.js';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-canary-mem-'));
process.env.WORKSPACES_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-canary-ws-'));

/** Memory agents' turns, captured: the conversation and the options the runner gave. */
const capturedTurns: Array<{ conversation: ConversationRow; opts: ChatTurnOptions }> = [];
vi.mock('../chat/service.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../chat/service.js')>()),
	runChatTurnHeadless: vi.fn(
		async (
			_userId: string,
			conversation: ConversationRow,
			_body: unknown,
			opts: ChatTurnOptions
		) => {
			capturedTurns.push({ conversation, opts });
			return { status: 'complete', error: null, abortReason: null, openAskUser: null };
		}
	)
}));

const { getDb } = await import('../db/index.js');
const { createApiKey } = await import('../db/repo/api-keys.js');
const { listMcpServers } = await import('../db/repo/mcp-servers.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { seedBuiltinAgent, seedMemoryCleanupAgent, MEMORY_CLEANUP_AGENT, MEMORY_EXTRACTION_AGENT } =
	await import('../agents/builtin.js');
const { startAgentRun } = await import('../agents/runner.js');
const { writeConcept } = await import('../memory/bundle.js');
const { createMemoryServer } = await import('../mcp/servers/memory.js');
const { createChatSearchServer } = await import('../mcp/servers/chat-search.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');
const { TurnPrivacy } = await import('./taint.js');
const { CANARY, setRole } = await import('./fixtures.js');
const { useCanaryServer } = await import('./canary-harness.js');
const gatewayRoute = await import('../../../routes/api/mcp/+server.js');

const canary = useCanaryServer();
const { expectNoLeak, privateChat } = canary;
let fx: typeof canary.fx;
beforeEach(() => {
	fx = canary.fx;
	capturedTurns.length = 0;
	fs.rmSync(process.env.MEMORY_VOLUME!, { recursive: true, force: true });
});

type Ctx = Parameters<typeof createMemoryServer>[0];
type ServerFactory = (ctx: Ctx) => ReturnType<typeof createMemoryServer>;

async function callTool(
	factory: ServerFactory,
	ctx: Ctx,
	name: string,
	args: Record<string, unknown>
): Promise<string> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = factory(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tool = (await client.tools())[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return JSON.stringify(await tool.execute(args, { toolCallId: 't1', messages: [] }));
	} finally {
		await client.close();
		await server.close();
	}
}

/** A private user concept and a private shared concept, both holding the canary. */
async function seedPrivateConcepts() {
	const db = getDb();
	const audit = { author: 'user:admin', userId: fx.userId };
	await writeConcept(
		db,
		'user',
		fx.userId,
		'health/notes.md',
		{ frontmatter: { title: 'Health', private: true }, body: `kumquat ${CANARY}` },
		audit
	);
	await writeConcept(
		db,
		'shared',
		fx.userId,
		'house/alarm.md',
		{ frontmatter: { title: 'Alarm', private: true }, body: `kumquat ${CANARY}` },
		audit
	);
	await writeConcept(
		db,
		'user',
		fx.userId,
		'fruit.md',
		{ frontmatter: { title: 'Fruit' }, body: 'kumquat is a fruit' },
		audit
	);
}

/** Every read a model could make of memory, as the given caller. */
async function readAllMemory(ctx: Ctx): Promise<string> {
	const out = [
		await callTool(createMemoryServer, ctx, 'search_memory', { query: 'kumquat' }),
		await callTool(createMemoryServer, ctx, 'search_memory', { query: CANARY }),
		await callTool(createMemoryServer, ctx, 'list_concepts', {}),
		await callTool(createMemoryServer, ctx, 'list_concepts', { scope: 'shared' }),
		await callTool(createMemoryServer, ctx, 'read_concept', { path: 'health/notes.md' }),
		await callTool(createMemoryServer, ctx, 'read_concept', {
			path: 'house/alarm.md',
			scope: 'shared'
		})
	];
	return out.join('\n');
}

/**
 * The tools' caller context for a captured run turn, built the way the chat
 * engine builds it: trust from the (trusted) memory model capped by the
 * limits, taint from the conversation, plus the private-only view.
 */
function passCtx(turn: (typeof capturedTurns)[number], modelTrusted: boolean): Ctx {
	const limits = (turn.opts.tools ?? {}) as {
		trust?: 'untrusted';
		tainted?: boolean;
		privateOnly?: boolean;
	};
	const trust = modelTrusted && limits.trust !== 'untrusted' ? 'trusted' : 'untrusted';
	const db = getDb();
	return {
		userId: fx.userId,
		role: 'admin',
		workspaceDir: null,
		documentsDir: '',
		conversationId: turn.conversation.id,
		agentRunId: turn.opts.run?.runId ?? null,
		privacy: new TurnPrivacy(db, fx.userId, {
			conversationId: turn.conversation.id,
			agentRunId: turn.opts.run?.runId ?? null,
			trust,
			tainted: limits.tainted
		}),
		trust,
		...(limits.privateOnly ? { privateOnly: true } : {})
	} as Ctx;
}

function memoryAgentId(name: string): string {
	const db = getDb();
	seedBuiltinAgent(db);
	seedMemoryCleanupAgent(db);
	return (
		db.prepare('SELECT id FROM agents WHERE name = ? AND user_id IS NULL').get(name) as {
			id: string;
		}
	).id;
}

describe('egress canary: private memory (PR 6)', () => {
	it('memory search in an untrusted turn never sees a private concept (user and shared)', async () => {
		await seedPrivateConcepts();
		const db = getDb();
		const c = createConversation(db, fx.userId, { title: 'public', ...fx.untrusted });
		const ctx: Ctx = {
			userId: fx.userId,
			role: 'admin',
			workspaceDir: null,
			documentsDir: '',
			conversationId: c.id,
			privacy: new TurnPrivacy(db, fx.userId, { conversationId: c.id, trust: 'untrusted' }),
			trust: 'untrusted'
		};
		const seen = await readAllMemory(ctx);
		expect(seen).not.toContain(CANARY);
		expect(seen).toContain('fruit.md');
		expect(seen).toContain('private result');
		expectNoLeak();
	});

	it('gateway: search_memory and read_concept never return a private concept', async () => {
		await seedPrivateConcepts();
		const db = getDb();
		db.prepare("UPDATE mcp_servers SET enabled = 1 WHERE name = 'memory' AND builtin = 1").run();
		const memory = listMcpServers(db).find((r) => r.name === 'memory' && r.builtin === 1)!;
		const { rawKey } = await createApiKey(db, {
			userId: fx.userId,
			label: 'external',
			scopes: ['mcp:use'],
			mcpAccess: [{ serverId: memory.id, tools: null }]
		});
		const routeFetch = async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			return (request.method === 'POST' ? gatewayRoute.POST : gatewayRoute.GET)({
				request,
				url: new URL(request.url)
			} as never);
		};
		const client = new Client({ name: 'test', version: '1.0.0' });
		await client.connect(
			new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
				fetch: routeFetch,
				requestInit: { headers: { authorization: `Bearer ${rawKey}` } }
			})
		);
		try {
			const calls = [
				['search_memory', { query: 'kumquat' }],
				['search_memory', { query: CANARY }],
				['list_concepts', {}],
				['list_concepts', { scope: 'shared' }],
				['read_concept', { path: 'health/notes.md' }],
				['read_concept', { path: 'house/alarm.md', scope: 'shared' }]
			] as const;
			const results = [];
			for (const [name, args] of calls) {
				results.push(JSON.stringify((await client.callTool({ name, arguments: args })).content));
			}
			const seen = results.join('\n');
			expect(seen).not.toContain(CANARY);
			expect(seen).toContain('fruit.md');
			expect(results[4]).toContain('concept not found');
			expect(results[5]).toContain('concept not found');
		} finally {
			await client.close();
		}
		expectNoLeak();
	});

	it('extraction on a trusted model: the public pass never reads private chats or concepts', async () => {
		await seedPrivateConcepts();
		const chat = privateChat(fx.trusted);
		const db = getDb();
		const publicChat = createConversation(db, fx.userId, { title: 'public', ...fx.trusted });
		createMessage(db, {
			conversationId: publicChat.id,
			role: 'user',
			parts: [{ type: 'text', text: 'I like kumquats' }]
		});
		setRole(db, 'memory', fx.trusted);

		const started = await startAgentRun({
			agentId: memoryAgentId(MEMORY_EXTRACTION_AGENT),
			trigger: 'manual',
			userId: fx.userId
		});
		await started.done;
		expect(capturedTurns).toHaveLength(2);
		const [publicPass, privatePass] = capturedTurns;
		expect(publicPass.conversation.private).toBe(0);
		expect(privatePass.conversation.private).toBe(1);

		const ctx = passCtx(publicPass, true);
		const seen = [
			await callTool(createChatSearchServer, ctx, 'search_chats', { since: '0' }),
			await callTool(createChatSearchServer, ctx, 'search_chats', { query: CANARY }),
			await callTool(createChatSearchServer, ctx, 'read_chat', { conversationId: chat.id }),
			await readAllMemory(ctx)
		].join('\n');
		expect(seen).not.toContain(CANARY);
		expect(seen).toContain(publicChat.id);
		expect(seen).not.toContain(`"id":"${chat.id}"`);

		// The private pass starts tainted, so whatever it writes is private.
		const priv = passCtx(privatePass, true);
		expect(priv.privacy?.tainted).toBe(true);
		const created = await callTool(createMemoryServer, priv, 'create_concept', {
			path: 'from-private.md',
			title: 'From a private chat',
			body: 'x'
		});
		expect(created).toContain('(private)');
		expectNoLeak();
	});

	it('extraction on an untrusted model runs the public pass only', async () => {
		setRole(getDb(), 'memory', fx.untrusted);
		const started = await startAgentRun({
			agentId: memoryAgentId(MEMORY_EXTRACTION_AGENT),
			trigger: 'manual',
			userId: fx.userId
		});
		await started.done;
		expect(capturedTurns).toHaveLength(1);
		expect(capturedTurns[0].conversation.private).toBe(0);
	});

	it('cleanup on an untrusted memory model skips private concepts', async () => {
		await seedPrivateConcepts();
		setRole(getDb(), 'memory', fx.untrusted);
		const started = await startAgentRun({
			agentId: memoryAgentId(MEMORY_CLEANUP_AGENT),
			trigger: 'event',
			userId: fx.userId
		});
		await started.done;
		expect(capturedTurns).toHaveLength(1);
		const ctx = passCtx(capturedTurns[0], false);
		expect(await readAllMemory(ctx)).not.toContain(CANARY);
		const del = await callTool(createMemoryServer, ctx, 'delete_concept', {
			path: 'health/notes.md'
		});
		expect(del).toContain('concept not found');
		expect(
			fs.existsSync(path.join(process.env.MEMORY_VOLUME!, fx.userId, 'health', 'notes.md'))
		).toBe(true);
		expectNoLeak();
	});
});
