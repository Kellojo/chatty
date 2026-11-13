// The MCP gateway: serves the MCP servers a user exposes (Settings → API) to
// outside MCP clients such as Claude Code, over Streamable HTTP at /api/mcp.
//
// Stateless: every POST gets a fresh MCP server and transport, so nothing is
// kept between requests and any number of clients can connect. Tools come from
// the same registry chats use (`buildTools`), so builtin servers act as the
// key's user, external servers share the connection pool, OAuth servers use
// the user's own sign-in, and calls count towards Settings → MCP servers usage.

import { randomUUID } from 'node:crypto';
import { asSchema, type Tool } from 'ai';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool as McpTool
} from '@modelcontextprotocol/sdk/types.js';
import type { ApiKeyIdentity } from '../auth/apiKey.js';
import { getDb } from '../db/index.js';
import { recordMcpGatewayCall, resolveMcpAccess } from '../db/repo/mcp-gateway.js';
import { createLogger } from '../logger.js';
import { buildTools, type BuiltTools } from '../tools/registry.js';

const log = createLogger('mcp-gateway');

export const MCP_GATEWAY_SCOPE = 'mcp:use';

const INSTRUCTIONS =
	"Tools from Chatty, the user's self-hosted AI chat app. They act as the user who owns the " +
	'API key: memory, past chats, skills, agents and the other servers they chose to share.';

function isCallToolResult(value: unknown): value is CallToolResult {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as { content?: unknown }).content)
	);
}

/** MCP tools already answer with a CallToolResult; anything else is sent as JSON text. */
function toCallToolResult(value: unknown): CallToolResult {
	if (isCallToolResult(value)) return value;
	const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
	return { content: [{ type: 'text', text }] };
}

async function describe(name: string, tool: Tool): Promise<McpTool> {
	const schema = (await asSchema(tool.inputSchema).jsonSchema) as McpTool['inputSchema'];
	return {
		name,
		description: typeof tool.description === 'string' ? tool.description : undefined,
		inputSchema: { ...schema, type: 'object' }
	};
}

function createGatewayServer(identity: ApiKeyIdentity, tools: () => Promise<BuiltTools>): Server {
	const server = new Server(
		{ name: 'chatty', version: '1.0.0' },
		{ capabilities: { tools: {} }, instructions: INSTRUCTIONS }
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const built = await tools();
		return {
			tools: await Promise.all(Object.entries(built.tools).map(([n, t]) => describe(n, t)))
		};
	});
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name, arguments: args } = request.params;
		const tool = (await tools()).tools[name];
		if (!tool?.execute) {
			return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
		}
		try {
			const result = await tool.execute(args ?? {}, {
				toolCallId: randomUUID(),
				messages: [],
				abortSignal: extra.signal,
				context: undefined
			});
			return toCallToolResult(result);
		} catch (e) {
			// The registry already counted the failure; the client gets it as a tool error.
			log.warn('Gateway tool call failed', {
				userId: identity.userId,
				tool: name,
				error: e instanceof Error ? e.message : String(e)
			});
			return {
				content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
				isError: true
			};
		}
	});
	return server;
}

/** The tools a key may use: its servers, narrowed to the tools it was given. */
async function buildKeyTools(identity: ApiKeyIdentity): Promise<BuiltTools> {
	const db = getDb();
	const access = resolveMcpAccess(db, identity.mcpAccess);
	const built = await buildTools({
		userId: identity.userId,
		// Never admin: an approved third-party client must not edit shared memory or global settings.
		role: 'user',
		memoryEnabled: true,
		servers: access.servers,
		onToolCall: (row, outcome) => {
			try {
				recordMcpGatewayCall(db, {
					apiKeyId: identity.keyId,
					userId: identity.userId,
					serverId: row.id,
					toolName: outcome.tool,
					ok: outcome.ok,
					durationMs: outcome.durationMs
				});
			} catch (e) {
				log.warn('Recording a gateway tool call failed', { error: String(e) });
			}
		}
	});
	const tools = Object.fromEntries(
		Object.entries(built.tools).filter(([name]) => {
			const allowed = access.tools.get(built.toolToServer[name]);
			return allowed === null || allowed?.has(name) === true;
		})
	);
	return { ...built, tools };
}

/** Answers one MCP request (a JSON-RPC message or batch) for an `mcp:use` key. */
export async function handleMcpGatewayRequest(
	request: Request,
	identity: ApiKeyIdentity
): Promise<Response> {
	// Tools are only built when a request needs them (not for initialize or notifications).
	const state: { built: Promise<BuiltTools> | null } = { built: null };
	const tools = () => (state.built ??= buildKeyTools(identity));
	const server = createGatewayServer(identity, tools);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		// Plain JSON answers: the response is complete once handleRequest resolves,
		// so the tools can be closed right after.
		enableJsonResponse: true
	});
	try {
		await server.connect(transport);
		return await transport.handleRequest(request);
	} finally {
		await server.close().catch(() => undefined);
		await (await state.built?.catch(() => null))?.close();
	}
}
