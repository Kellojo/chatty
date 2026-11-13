import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { listToolInfo } from '$lib/server/tools/registry.js';
import type { RequestHandler } from './$types';

/** Every tool an API key can be given through the MCP gateway (connects to the servers). */
export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	return json({ tools: await listToolInfo(user.id) });
};
