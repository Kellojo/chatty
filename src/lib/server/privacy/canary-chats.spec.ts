/**
 * Egress canary rows for private chats (PR 4): agent runs, subagents, coding
 * hand-offs and the MCP gateway. See canary.spec.ts for how the harness works.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createAgent } = await import('../db/repo/agents.js');
const { createAgentRun, finishAgentRun } = await import('../db/repo/agent-runs.js');
const { createApiKey } = await import('../db/repo/api-keys.js');
const { listMcpServers } = await import('../db/repo/mcp-servers.js');
const { runSubagent } = await import('../agents/subagents.js');
const { createAgentsServer, PRIVATE_RUN_NOTE } = await import('../mcp/servers/agents.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');
const { isConversationPrivate } = await import('./policy.js');
const { TurnPrivacy } = await import('./taint.js');
const { CANARY } = await import('./fixtures.js');
const { useCanaryServer } = await import('./canary-harness.js');
const gatewayRoute = await import('../../../routes/api/mcp/+server.js');
const handoffRoute =
	await import('../../../routes/api/conversations/[id]/handoff-draft/+server.js');

const canary = useCanaryServer();
const { recorded, trustedSaw, expectNoLeak, privateChat } = canary;
let fx: typeof canary.fx;
beforeEach(() => {
	fx = canary.fx;
});

function enableServers(...names: string[]) {
	const db = getDb();
	for (const name of names) {
		db.prepare('UPDATE mcp_servers SET enabled = 1 WHERE name = ? AND builtin = 1').run(name);
	}
}

function serverRow(name: string) {
	const row = listMcpServers(getDb()).find((r) => r.name === name && r.builtin === 1);
	if (!row) throw new Error(`no builtin ${name}`);
	return row;
}

/** A public chat on `model` and its turn's privacy. */
function publicTurn(
	model: { providerId: string; modelId: string },
	trust: 'trusted' | 'untrusted'
) {
	const db = getDb();
	const c = createConversation(db, fx.userId, { title: 'public', ...model, private: false });
	return {
		conversation: c,
		privacy: new TurnPrivacy(db, fx.userId, { conversationId: c.id, trust })
	};
}

/** A private agent's finished run whose reply holds the canary. */
function privateAgentRun() {
	const db = getDb();
	const agent = createAgent(db, fx.userId, {
		name: 'secret agent',
		systemPrompt: 'x',
		triggerType: 'manual',
		private: true,
		...fx.trusted
	});
	const conversation = createConversation(db, fx.userId, {
		kind: 'agent-run',
		agentId: agent.id,
		private: true
	});
	createMessage(db, {
		conversationId: conversation.id,
		role: 'assistant',
		parts: [{ type: 'text', text: `Found: ${CANARY}` }]
	});
	const run = createAgentRun(db, {
		agentId: agent.id,
		userId: fx.userId,
		trigger: 'manual',
		conversationId: conversation.id
	});
	finishAgentRun(db, run.id, 'success');
	return run.id;
}

async function callAgentsTool(
	ctx: Parameters<typeof createAgentsServer>[0],
	name: string,
	args: Record<string, unknown>
): Promise<string> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createAgentsServer(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tool = (await client.tools())[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<{ content?: { text?: string }[] }>;
		};
		const res = await tool.execute(args, { toolCallId: 't1', messages: [] });
		return res.content?.[0]?.text ?? '';
	} finally {
		await client.close();
		await server.close();
	}
}

const subagentTurns = () => trustedSaw().filter((r) => r.body.includes('You are a subagent'));

describe('egress canary: agent runs and subagents (PR 4)', () => {
	it("agent result: a private run's result never reaches an untrusted caller", async () => {
		const runId = privateAgentRun();
		const { conversation, privacy } = publicTurn(fx.untrusted, 'untrusted');
		const text = await callAgentsTool(
			{
				userId: fx.userId,
				role: 'user',
				workspaceDir: null,
				documentsDir: '',
				conversationId: conversation.id,
				privacy,
				trust: 'untrusted'
			},
			'get_agent_run',
			{ runId }
		);
		expect(text).not.toContain(CANARY);
		expect(JSON.parse(text).note).toBe(PRIVATE_RUN_NOTE);
		expect(isConversationPrivate(getDb(), conversation.id)).toBe(false);
		expectNoLeak();
	});

	it('subagent: a private parent starts a private, tainted subagent', async () => {
		enableServers('webfetch');
		const parent = privateChat(fx.trusted);
		const result = await runSubagent({
			userId: fx.userId,
			parentConversationId: parent.id,
			description: 'look',
			prompt: `Summarise ${CANARY}`
		});
		expect(isConversationPrivate(getDb(), result.conversationId)).toBe(true);
		const turns = subagentTurns();
		expect(turns.length).toBeGreaterThan(0);
		// It keeps the parent's tools; only its model calls are limited to trusted providers.
		for (const t of turns) expect(t.body).toMatch(/"name":"fetch"/);
		expectNoLeak();
	});

	it("subagent: a private subagent's report taints a public parent on a trusted model", async () => {
		const db = getDb();
		const parent = publicTurn(fx.trusted, 'trusted');
		const pending = runSubagent({
			userId: fx.userId,
			parentConversationId: parent.conversation.id,
			description: 'look',
			prompt: 'Look something up',
			parentPrivacy: parent.privacy
		});
		// The subagent's chat exists once runSubagent returns its promise: it turns
		// private as if it had read private data.
		const sub = db
			.prepare('SELECT id FROM conversations WHERE subagent_of = ?')
			.get(parent.conversation.id) as { id: string };
		db.prepare('UPDATE conversations SET private = 1 WHERE id = ?').run(sub.id);
		const result = await pending;
		expect(result.status).toBe('completed');
		expect(parent.privacy.tainted).toBe(true);
		expect(isConversationPrivate(db, parent.conversation.id)).toBe(true);
		expectNoLeak();
	});
});

describe('egress canary: coding (PR 4)', () => {
	it('hand-off: a private chat is refused before any model call', async () => {
		const chat = privateChat(fx.trusted);
		await expect(
			handoffRoute.POST({
				locals: { user: { id: fx.userId } },
				params: { id: chat.id }
			} as never)
		).rejects.toMatchObject({
			status: 409,
			body: { message: "Private chats can't be handed off to a coding agent" }
		});
		expect(recorded).toEqual([]);
	});
});

describe('egress canary: MCP gateway (PR 4)', () => {
	async function connect(rawKey: string): Promise<Client> {
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
		return client;
	}

	it('gateway: read_chat and search_chats never return a private chat', async () => {
		enableServers('chat-search');
		const db = getDb();
		const chat = privateChat(fx.trusted);
		const { rawKey } = await createApiKey(db, {
			userId: fx.userId,
			label: 'external',
			scopes: ['mcp:use'],
			mcpAccess: [{ serverId: serverRow('chat-search').id, tools: null }]
		});
		const client = await connect(rawKey);
		try {
			const search = await client.callTool({
				name: 'search_chats',
				arguments: { query: CANARY }
			});
			const searchText = JSON.stringify(search.content);
			expect(searchText).not.toContain(chat.id);
			expect(searchText).not.toContain(CANARY);
			expect(searchText).toContain('1 private result hidden');

			const listing = await client.callTool({ name: 'search_chats', arguments: { since: '0' } });
			expect(JSON.stringify(listing.content)).not.toContain(chat.id);

			const read = await client.callTool({
				name: 'read_chat',
				arguments: { conversationId: chat.id }
			});
			expect(read.isError).toBe(true);
			expect(JSON.stringify(read.content)).toContain('conversation not found');
			expect(JSON.stringify(read.content)).not.toContain(CANARY);
		} finally {
			await client.close();
		}
		expect(isConversationPrivate(db, chat.id)).toBe(true);
		expectNoLeak();
	});
});
