import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { testConnection } from '$lib/server/mcp/clientManager.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireAdmin(locals);
	// OAuth servers are tested with the admin's own sign-in.
	return json(await testConnection(getDb(), params.id, user.id));
};
