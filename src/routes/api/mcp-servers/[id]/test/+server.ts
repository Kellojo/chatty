import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { requireManageableMcpServer } from '$lib/server/mcp/access.js';
import { testConnection } from '$lib/server/mcp/clientManager.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	requireManageableMcpServer(db, params.id, user);
	// OAuth servers are tested with the caller's own sign-in.
	return json(await testConnection(db, params.id, user.id));
};
