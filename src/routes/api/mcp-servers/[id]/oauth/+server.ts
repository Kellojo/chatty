import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { createLogger } from '$lib/server/logger.js';
import { disconnectMcpOAuth, startMcpOAuth } from '$lib/server/mcp/oauth.js';
import { invalidateMcpServerForUser } from '$lib/server/mcp/pool.js';
import type { RequestHandler } from './$types';

const log = createLogger('mcp-oauth');

/**
 * Starts the signed-in user's OAuth sign-in to an MCP server. Any user may connect
 * their own account; only admins configure servers. Answers with the URL to send the
 * browser to, or `connected: true` when existing tokens could simply be renewed.
 */
export const POST: RequestHandler = async ({ locals, params, url }) => {
	const user = requireUser(locals);
	try {
		const result = await startMcpOAuth(getDb(), params.id, user.id, url.origin);
		if (result.connected) invalidateMcpServerForUser(params.id, user.id);
		return json(result);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		log.warn('Starting MCP OAuth sign-in failed', { serverId: params.id, error: message });
		error(400, { message });
	}
};

/** Signs the user out of the server: their tokens are deleted. */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	disconnectMcpOAuth(getDb(), params.id, user.id);
	invalidateMcpServerForUser(params.id, user.id);
	return json({ ok: true });
};
