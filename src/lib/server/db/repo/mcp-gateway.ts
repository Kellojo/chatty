import type { McpGatewayServer, McpGatewayUsage, McpKeyAccess } from '$lib/types.js';
import type { Db } from '../index.js';
import { listConnectedMcpServerIds } from './mcp-oauth-sessions.js';
import { listEnabledMcpServers, type McpServerRow } from './mcp-servers.js';
import { usageDay } from './mcp-tool-usage.js';

const DAY_MS = 24 * 60 * 60_000;
/** How far back the gateway overview looks. */
export const MCP_GATEWAY_USAGE_DAYS = 30;
/** Tools listed per server in the overview. */
const TOP_TOOLS = 3;

/**
 * Builtin servers left out of a new key's access. Coding agents (the gateway's
 * main clients) already have their own, better file, shell, math and clock
 * tools. `agents` starts runs that use the agent's own tools, which reaches
 * past the key's picks, so it must be chosen on purpose.
 */
const HIDDEN_BY_DEFAULT = new Set(['fs', 'code-exec', 'math', 'datetime', 'wait', 'agents']);

export function exposedByDefault(row: Pick<McpServerRow, 'name' | 'builtin'>): boolean {
	return !(row.builtin === 1 && HIDDEN_BY_DEFAULT.has(row.name));
}

/** A new key's access: the default servers, with all their tools. */
export function defaultMcpAccess(db: Db): McpKeyAccess {
	return listEnabledMcpServers(db)
		.filter(exposedByDefault)
		.map((row) => ({ serverId: row.id, tools: null }));
}

export interface ResolvedMcpAccess {
	/** Enabled servers the key may use. */
	servers: McpServerRow[];
	/** Per server name: the tools the key may call, or null for all of them. */
	tools: Map<string, Set<string> | null>;
}

/** What a key may use right now; servers since deleted or disabled are left out. */
export function resolveMcpAccess(db: Db, access: McpKeyAccess | null): ResolvedMcpAccess {
	const entries = new Map((access ?? defaultMcpAccess(db)).map((e) => [e.serverId, e.tools]));
	const servers = listEnabledMcpServers(db).filter((row) => entries.has(row.id));
	return {
		servers,
		tools: new Map(
			servers.map((row) => {
				const tools = entries.get(row.id);
				return [row.name, tools ? new Set(tools) : null];
			})
		)
	};
}

/** Every enabled server, as the gateway overview and the key editor show it. */
export function listMcpGatewayServers(db: Db, userId: string): McpGatewayServer[] {
	const connected = listConnectedMcpServerIds(db, userId);
	return listEnabledMcpServers(db).map((row) => ({
		id: row.id,
		name: row.name,
		builtin: row.builtin === 1,
		transport: row.transport,
		toolCount: row.tool_count ?? null,
		exposedByDefault: exposedByDefault(row),
		needsSignIn: row.auth === 'oauth' && !connected.has(row.id)
	}));
}

export interface McpGatewayCallInput {
	apiKeyId: string;
	userId: string;
	serverId: string;
	toolName: string;
	ok: boolean;
	durationMs: number;
	at?: number;
}

export function recordMcpGatewayCall(db: Db, input: McpGatewayCallInput): void {
	const at = input.at ?? Date.now();
	db.prepare(
		`INSERT INTO mcp_gateway_usage
		   (api_key_id, user_id, server_id, tool_name, day, calls, errors, total_ms, last_used_at)
		 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
		 ON CONFLICT (api_key_id, server_id, tool_name, day) DO UPDATE SET
		   calls = calls + 1,
		   errors = errors + excluded.errors,
		   total_ms = total_ms + excluded.total_ms,
		   last_used_at = MAX(last_used_at, excluded.last_used_at)`
	).run(
		input.apiKeyId,
		input.userId,
		input.serverId,
		input.toolName,
		usageDay(at),
		input.ok ? 0 : 1,
		Math.max(0, Math.round(input.durationMs)),
		at
	);
}

/** A user's gateway tool calls over the last `days` UTC days (today included). */
export function getMcpGatewayUsage(
	db: Db,
	userId: string,
	days = MCP_GATEWAY_USAGE_DAYS,
	now = Date.now()
): McpGatewayUsage {
	const rows = db
		.prepare(
			`SELECT api_key_id, server_id, tool_name, SUM(calls) AS calls, SUM(errors) AS errors,
			        MAX(last_used_at) AS last_used_at
			 FROM mcp_gateway_usage WHERE user_id = ? AND day >= ?
			 GROUP BY api_key_id, server_id, tool_name`
		)
		.all(userId, usageDay(now - (days - 1) * DAY_MS)) as {
		api_key_id: string;
		server_id: string;
		tool_name: string;
		calls: number;
		errors: number;
		last_used_at: number;
	}[];
	const usage: McpGatewayUsage = { days, calls: 0, errors: 0, byKey: {}, byServer: {} };
	const tools = new Map<string, Map<string, number>>();
	for (const r of rows) {
		usage.calls += r.calls;
		usage.errors += r.errors;
		const key = (usage.byKey[r.api_key_id] ??= { calls: 0, errors: 0, lastUsedAt: 0 });
		key.calls += r.calls;
		key.errors += r.errors;
		key.lastUsedAt = Math.max(key.lastUsedAt, r.last_used_at);
		const server = (usage.byServer[r.server_id] ??= {
			calls: 0,
			errors: 0,
			lastUsedAt: 0,
			topTools: []
		});
		server.calls += r.calls;
		server.errors += r.errors;
		server.lastUsedAt = Math.max(server.lastUsedAt, r.last_used_at);
		const perTool = tools.get(r.server_id) ?? new Map<string, number>();
		perTool.set(r.tool_name, (perTool.get(r.tool_name) ?? 0) + r.calls);
		tools.set(r.server_id, perTool);
	}
	for (const [serverId, perTool] of tools) {
		usage.byServer[serverId].topTools = [...perTool]
			.map(([tool, calls]) => ({ tool, calls }))
			.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
			.slice(0, TOP_TOOLS);
	}
	return usage;
}
