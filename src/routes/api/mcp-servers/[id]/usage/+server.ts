import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getMcpServerUsage } from '$lib/server/db/repo/mcp-tool-usage.js';
import { requireManageableMcpServer } from '$lib/server/mcp/access.js';
import type { RequestHandler } from './$types';

/** Per-tool and per-day tool calls of one server, across all users who can use it. */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	requireManageableMcpServer(db, params.id, user);
	return json(getMcpServerUsage(db, params.id));
};
