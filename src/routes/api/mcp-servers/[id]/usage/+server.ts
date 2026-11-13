import { error, json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getMcpServer } from '$lib/server/db/repo/mcp-servers.js';
import { getMcpServerUsage } from '$lib/server/db/repo/mcp-tool-usage.js';
import type { RequestHandler } from './$types';

/** Per-tool and per-day tool calls of one server, across all users. */
export const GET: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	const db = getDb();
	if (!getMcpServer(db, params.id)) error(404, 'MCP server not found');
	return json(getMcpServerUsage(db, params.id));
};
