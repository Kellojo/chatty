import path from 'node:path';
import type { Tool } from 'ai';
import type { ToolInfo } from '$lib/types.js';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { listEnabledMcpServers, type McpServerRow } from '../db/repo/mcp-servers.js';
import { createLogger } from '../logger.js';
import { connectServer, MCP_LIST_TIMEOUT_MS, withTimeout } from '../mcp/clientManager.js';
import { acquireMcpServer, cachedMcpTools, type McpLease } from '../mcp/pool.js';
import type { CallerContext } from '../mcp/types.js';
import { pickDeferredTools, SEARCH_TOOLS_NAME, type ToolCatalog } from './toolSearch.js';
import { wrapMcpTools } from './wrap.js';

const log = createLogger('tools');

export interface BuildToolsInput {
	userId: string;
	memoryEnabled: boolean;
	workspaceDir?: string | null;
	agentAllowlist?: string[];
	author?: string;
	conversationId?: string | null;
	agentRunId?: string | null;
}

export interface BuiltTools extends ToolCatalog {
	close: () => Promise<void>;
}

export async function buildTools(input: BuildToolsInput): Promise<BuiltTools> {
	const db = getDb();
	const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(input.userId) as
		{ role: string } | undefined;
	const ctx: CallerContext = {
		userId: input.userId,
		role: user?.role ?? 'user',
		workspaceDir: input.workspaceDir ?? null,
		documentsDir: path.join(path.resolve(config.DOCUMENTS_VOLUME), input.userId),
		author: input.author,
		conversationId: input.conversationId,
		agentRunId: input.agentRunId
	};
	const rows = listEnabledMcpServers(db).filter(
		(row) => input.memoryEnabled || row.name !== 'memory'
	);
	const tools: Record<string, Tool> = {};
	const toolToServer: Record<string, string> = {};
	const closers: Array<() => Promise<void>> = [];
	const results = await Promise.allSettled(
		rows.map((row) => (row.transport === 'builtin' ? openBuiltin(row, ctx) : openPooled(row)))
	);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const result = results[i];
		if (result.status === 'rejected') {
			log.warn(`MCP server ${row.name} unavailable:`, {
				error: result.reason instanceof Error ? result.reason.message : String(result.reason)
			});
			continue;
		}
		closers.push(result.value.close);
		const set = wrapMcpTools(result.value.tools, row.name, result.value.onError);
		for (const [name, tool] of Object.entries(set)) {
			if (tools[name] || name === SEARCH_TOOLS_NAME) {
				log.warn(`MCP tool name collision: "${name}" from ${row.name} skipped`);
				continue;
			}
			tools[name] = tool;
			toolToServer[name] = row.name;
		}
	}
	let filtered = tools;
	// An allowlist is already a hand-picked, small set: nothing is deferred.
	let deferred = new Set<string>();
	if (input.agentAllowlist) {
		filtered = {};
		for (const name of input.agentAllowlist) {
			if (tools[name]) filtered[name] = tools[name];
		}
	} else {
		const deferredServers = new Set(
			rows.filter((row) => row.load_mode === 'deferred').map((row) => row.name)
		);
		deferred = pickDeferredTools(tools, toolToServer, deferredServers);
	}
	return {
		tools: filtered,
		toolToServer,
		deferred,
		close: async () => {
			for (const closer of closers.reverse()) {
				await closer().catch(() => undefined);
			}
		}
	};
}

interface OpenedServer {
	tools: Record<string, Tool>;
	close: () => Promise<void>;
	onError?: (error: unknown) => void;
}

/** Builtin servers are bound to the caller (user, workspace, conversation), so each turn gets its own in-memory pair. */
async function openBuiltin(row: McpServerRow, ctx: CallerContext): Promise<OpenedServer> {
	const conn = await connectServer(row, ctx);
	try {
		const listed = await withTimeout(
			conn.client.tools(),
			`Listing tools of MCP server ${row.name}`,
			undefined,
			MCP_LIST_TIMEOUT_MS
		);
		return { tools: listed as unknown as Record<string, Tool>, close: conn.close };
	} catch (e) {
		await conn.close().catch(() => undefined);
		throw e;
	}
}

// Errors that mean the transport is gone rather than that the tool call failed.
const CONNECTION_ERROR =
	/connection closed|not connected|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed|terminated/i;

/**
 * External servers come from the shared pool; the lease is returned when the
 * turn ends. Once a server's tool list is known, a turn offers those tools
 * without connecting, and connects on the first call of one of them.
 */
async function openPooled(row: McpServerRow): Promise<OpenedServer> {
	const cached = cachedMcpTools(row);
	if (!cached) {
		const lease = await acquireMcpServer(row);
		return {
			tools: lease.tools,
			close: async () => lease.release(),
			onError: (e) => {
				if (isConnectionError(e)) lease.markBroken();
			}
		};
	}
	let pending: Promise<McpLease> | null = null;
	const lease = () => {
		pending ??= acquireMcpServer(row).catch((e: unknown) => {
			pending = null;
			throw e;
		});
		return pending;
	};
	const tools: Record<string, Tool> = {};
	for (const [name, listed] of Object.entries(cached)) {
		tools[name] = {
			...listed,
			execute: async (input: unknown, options: Parameters<NonNullable<Tool['execute']>>[1]) => {
				const current = (await lease()).tools[name];
				if (!current?.execute) throw new Error(`${row.name} no longer offers the tool ${name}`);
				return current.execute(input as never, options as never);
			}
		} as Tool;
	}
	return {
		tools,
		close: async () => {
			const acquired = await pending?.catch(() => null);
			acquired?.release();
		},
		onError: (e) => {
			if (isConnectionError(e))
				void pending?.then(
					(l) => l.markBroken(),
					() => undefined
				);
		}
	};
}

function isConnectionError(e: unknown): boolean {
	return CONNECTION_ERROR.test(e instanceof Error ? e.message : String(e));
}

/** Lists every tool currently available to the user (for pickers in the UI), sorted by server then name. */
export async function listToolInfo(userId: string): Promise<ToolInfo[]> {
	const built = await buildTools({ userId, memoryEnabled: true });
	try {
		return Object.entries(built.tools)
			.map(([name, t]) => ({
				name,
				description: typeof t.description === 'string' ? t.description : '',
				server: built.toolToServer[name] ?? ''
			}))
			.sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
	} finally {
		await built.close();
	}
}
