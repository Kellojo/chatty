import type { McpServerUsage, McpServerUsageDetail, McpUsageStats } from '$lib/types.js';
import type { Db } from '../index.js';

const DAY_MS = 24 * 60 * 60_000;
/** How far back the settings page looks. */
export const MCP_USAGE_WINDOW_DAYS = 30;

/** UTC calendar day of a timestamp, as stored in `mcp_tool_usage.day`. */
export function usageDay(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

/** First day (inclusive) of the window ending on the day of `now`. */
function windowStart(now: number, days: number): string {
	return usageDay(now - (days - 1) * DAY_MS);
}

export interface McpToolCallInput {
	serverId: string;
	toolName: string;
	userId: string;
	ok: boolean;
	durationMs: number;
	at?: number;
}

export function recordMcpToolCall(db: Db, input: McpToolCallInput): void {
	const at = input.at ?? Date.now();
	db.prepare(
		`INSERT INTO mcp_tool_usage (server_id, tool_name, user_id, day, calls, errors, total_ms, last_used_at)
		 VALUES (?, ?, ?, ?, 1, ?, ?, ?)
		 ON CONFLICT (server_id, tool_name, user_id, day) DO UPDATE SET
		   calls = calls + 1,
		   errors = errors + excluded.errors,
		   total_ms = total_ms + excluded.total_ms,
		   last_used_at = MAX(last_used_at, excluded.last_used_at)`
	).run(
		input.serverId,
		input.toolName,
		input.userId,
		usageDay(at),
		input.ok ? 0 : 1,
		Math.max(0, Math.round(input.durationMs)),
		at
	);
}

/** Per-server totals over the window, keyed by server id. `lastUsedAt` looks beyond the window. */
export function summarizeMcpUsage(
	db: Db,
	now = Date.now(),
	days = MCP_USAGE_WINDOW_DAYS
): Record<string, McpServerUsage> {
	const rows = db
		.prepare(
			`SELECT server_id,
			        SUM(CASE WHEN day >= ? THEN calls ELSE 0 END) AS calls,
			        SUM(CASE WHEN day >= ? THEN errors ELSE 0 END) AS errors,
			        COUNT(DISTINCT CASE WHEN day >= ? THEN user_id END) AS users,
			        MAX(last_used_at) AS last_used_at
			 FROM mcp_tool_usage GROUP BY server_id`
		)
		.all(...Array(3).fill(windowStart(now, days))) as {
		server_id: string;
		calls: number;
		errors: number;
		users: number;
		last_used_at: number;
	}[];
	const out: Record<string, McpServerUsage> = {};
	for (const r of rows) {
		out[r.server_id] = {
			calls: r.calls,
			errors: r.errors,
			users: r.users,
			lastUsedAt: r.last_used_at
		};
	}
	return out;
}

/** Every server's usage over `days`: per server, and per day split by server (oldest first). */
export function getMcpUsageStats(db: Db, days: number, now = Date.now()): McpUsageStats {
	const since = windowStart(now, days);
	const servers = db
		.prepare(
			`SELECT server_id AS serverId, SUM(calls) AS calls, SUM(errors) AS errors,
			        SUM(total_ms) AS total_ms, COUNT(DISTINCT user_id) AS users,
			        MAX(last_used_at) AS lastUsedAt
			 FROM mcp_tool_usage WHERE day >= ?
			 GROUP BY server_id ORDER BY calls DESC`
		)
		.all(since) as {
		serverId: string;
		calls: number;
		errors: number;
		total_ms: number;
		users: number;
		lastUsedAt: number;
	}[];
	const cells = db
		.prepare(
			`SELECT day, server_id, SUM(calls) AS calls, SUM(errors) AS errors
			 FROM mcp_tool_usage WHERE day >= ? GROUP BY day, server_id`
		)
		.all(since) as { day: string; server_id: string; calls: number; errors: number }[];
	const daily = Array.from({ length: days }, (_, i) => ({
		day: usageDay(now - (days - 1 - i) * DAY_MS),
		calls: {} as Record<string, number>,
		errors: {} as Record<string, number>
	}));
	const byDay = new Map(daily.map((d) => [d.day, d]));
	for (const c of cells) {
		const d = byDay.get(c.day);
		if (!d) continue;
		d.calls[c.server_id] = c.calls;
		d.errors[c.server_id] = c.errors;
	}
	const { users } = db
		.prepare(`SELECT COUNT(DISTINCT user_id) AS users FROM mcp_tool_usage WHERE day >= ?`)
		.get(since) as { users: number };
	return {
		days,
		users,
		servers: servers.map(({ total_ms, ...s }) => ({
			...s,
			avgMs: s.calls > 0 ? Math.round(total_ms / s.calls) : 0
		})),
		daily
	};
}

/** One server's usage over the window: per tool, and per day (every day present, oldest first). */
export function getMcpServerUsage(
	db: Db,
	serverId: string,
	now = Date.now(),
	days = MCP_USAGE_WINDOW_DAYS
): McpServerUsageDetail {
	const since = windowStart(now, days);
	const tools = db
		.prepare(
			`SELECT tool_name AS name, SUM(calls) AS calls, SUM(errors) AS errors,
			        SUM(total_ms) AS total_ms, COUNT(DISTINCT user_id) AS users,
			        MAX(last_used_at) AS lastUsedAt
			 FROM mcp_tool_usage WHERE server_id = ? AND day >= ?
			 GROUP BY tool_name ORDER BY calls DESC, name`
		)
		.all(serverId, since) as {
		name: string;
		calls: number;
		errors: number;
		total_ms: number;
		users: number;
		lastUsedAt: number;
	}[];
	const byDay = new Map(
		(
			db
				.prepare(
					`SELECT day, SUM(calls) AS calls, SUM(errors) AS errors
					 FROM mcp_tool_usage WHERE server_id = ? AND day >= ? GROUP BY day`
				)
				.all(serverId, since) as { day: string; calls: number; errors: number }[]
		).map((r) => [r.day, r])
	);
	const daily = Array.from({ length: days }, (_, i) => {
		const day = usageDay(now - (days - 1 - i) * DAY_MS);
		const hit = byDay.get(day);
		return { day, calls: hit?.calls ?? 0, errors: hit?.errors ?? 0 };
	});
	const { users } = db
		.prepare(
			`SELECT COUNT(DISTINCT user_id) AS users FROM mcp_tool_usage WHERE server_id = ? AND day >= ?`
		)
		.get(serverId, since) as { users: number };
	return {
		days,
		users,
		tools: tools.map((t) => ({
			name: t.name,
			calls: t.calls,
			errors: t.errors,
			users: t.users,
			avgMs: t.calls > 0 ? Math.round(t.total_ms / t.calls) : 0,
			lastUsedAt: t.lastUsedAt
		})),
		daily
	};
}
