import { createMCPClient, type MCPClient, type MCPTransport } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decryptSecret } from '../crypto.js';
import { getDb, type Db } from '../db/index.js';
import {
	getMcpServer,
	parseMcpArgs,
	setMcpToolCount,
	type McpServerRow
} from '../db/repo/mcp-servers.js';
import { createLogger } from '../logger.js';
import { connectionAuthProvider, oauthFetch, toSignInError } from './oauth.js';
import { BUILTIN_SERVERS } from './servers/index.js';
import type { CallerContext } from './types.js';

const log = createLogger('mcp-client');

export interface ServerConnection {
	client: MCPClient;
	close: () => Promise<void>;
}

/** How long connecting to or listing the tools of one MCP server may take. */
export const MCP_TIMEOUT_MS = 15_000;
/** Listing tools is one round trip on a live connection, so it gets a shorter budget. */
export const MCP_LIST_TIMEOUT_MS = 5_000;

/**
 * Rejects if `promise` doesn't settle within `ms`. A value that arrives after
 * the timeout is handed to `onLate` (e.g. to close a connection nobody uses).
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	label: string,
	onLate?: (value: T) => void,
	ms = MCP_TIMEOUT_MS
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(new Error(`${label} timed out after ${ms / 1000}s`));
		}, ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
		if (timedOut && onLate) promise.then(onLate, () => undefined);
	}
}

/**
 * Lists a connected server's tools within MCP_LIST_TIMEOUT_MS and remembers how
 * many there are, for Settings → MCP servers.
 */
export async function listServerTools(
	conn: ServerConnection,
	row: McpServerRow
): Promise<Awaited<ReturnType<MCPClient['tools']>>> {
	const tools = await withTimeout(
		conn.client.tools(),
		`Listing tools of MCP server ${row.name}`,
		undefined,
		MCP_LIST_TIMEOUT_MS
	);
	try {
		setMcpToolCount(getDb(), row.id, Object.keys(tools).length);
	} catch (e) {
		// Only shown in settings: never fail a turn over it.
		log.warn(`Recording the tool count of ${row.name} failed`, { error: String(e) });
	}
	return tools;
}

/** Connects to an MCP server; a dead or slow server fails after MCP_TIMEOUT_MS. */
export function connectServer(row: McpServerRow, ctx: CallerContext): Promise<ServerConnection> {
	return withTimeout(
		openServer(row, ctx),
		`Connecting to MCP server ${row.name}`,
		(conn) => void conn.close().catch(() => undefined)
	);
}

async function openServer(row: McpServerRow, ctx: CallerContext): Promise<ServerConnection> {
	if (row.transport === 'builtin') {
		const factory = BUILTIN_SERVERS[row.name];
		if (!factory) throw new Error(`Unknown builtin MCP server: ${row.name}`);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = factory(ctx);
		await server.connect(serverTransport);
		const client = await createMCPClient({
			transport: clientTransport as unknown as MCPTransport,
			maxRetries: 2
		});
		return {
			client,
			close: async () => {
				await client.close();
				await server.close();
			}
		};
	}
	if (row.transport === 'stdio') return connectStdio(row);
	if (!row.url) throw new Error(`MCP server ${row.name} has no url configured`);
	const type = row.transport === 'sse' ? 'sse' : 'http';
	if (row.auth === 'oauth') {
		// The caller's own access token; refreshed by the transport when it expires.
		const authProvider = connectionAuthProvider(getDb(), row, ctx.userId);
		try {
			const client = await createMCPClient({
				// Token refreshes go through oauthFetch too (see there).
				transport: { type, url: row.url, authProvider, fetch: oauthFetch },
				maxRetries: 2
			});
			return { client, close: () => client.close() };
		} catch (e) {
			throw toSignInError(e, row);
		}
	}
	const headers: Record<string, string> = {};
	if (row.token_enc) headers.authorization = `Bearer ${decryptSecret(row.token_enc)}`;
	const client = await createMCPClient({
		transport: { type, url: row.url, headers },
		maxRetries: 2
	});
	return { client, close: () => client.close() };
}

/**
 * Spawns the configured command (no shell) and talks MCP over its stdio. The
 * child only inherits the SDK's minimal default environment (PATH, HOME, ...),
 * not Chatty's own secrets. `close()` always terminates the process, and a
 * failed handshake does too, so no child outlives its connection.
 */
async function connectStdio(row: McpServerRow): Promise<ServerConnection> {
	if (!row.command) throw new Error(`MCP server ${row.name} has no command configured`);
	const transport = new StdioClientTransport({
		command: row.command,
		args: parseMcpArgs(row.args)
	});
	let client: MCPClient;
	try {
		client = await createMCPClient({
			transport: transport as unknown as MCPTransport,
			maxRetries: 2
		});
	} catch (e) {
		await transport.close().catch(() => undefined);
		throw e;
	}
	return {
		client,
		close: async () => {
			try {
				await client.close();
			} finally {
				await transport.close();
			}
		}
	};
}

export interface TestConnectionTool {
	name: string;
	description?: string;
}

export interface TestConnectionResult {
	ok: boolean;
	tools: TestConnectionTool[];
	error?: string;
}

const TEST_CTX: CallerContext = {
	userId: 'connection-test',
	role: 'admin',
	workspaceDir: null,
	documentsDir: ''
};

/** Connects once and lists the tools; OAuth servers are tested with `userId`'s sign-in. */
export async function testConnection(
	db: Db,
	serverId: string,
	userId?: string
): Promise<TestConnectionResult> {
	const row = getMcpServer(db, serverId);
	if (!row) return { ok: false, tools: [], error: 'Server not found' };
	try {
		const conn = await connectServer(row, userId ? { ...TEST_CTX, userId } : TEST_CTX);
		try {
			const tools = await listServerTools(conn, row);
			return {
				ok: true,
				tools: Object.entries(tools).map(([name, tool]) => ({
					name,
					description: typeof tool.description === 'string' ? tool.description : undefined
				}))
			};
		} finally {
			await conn.close();
		}
	} catch (e) {
		return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
	}
}
