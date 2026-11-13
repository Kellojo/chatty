import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { parseMcpAccess } from '$lib/server/db/repo/api-keys.js';
import { listMcpGatewayServers } from '$lib/server/db/repo/mcp-gateway.js';
import { findOAuthKey } from '$lib/server/db/repo/oauth.js';
import { checkAuthorizeRequest } from '$lib/server/oauth-server/index.js';
import type { PageServerLoad } from './$types';

// The OAuth authorization endpoint: an MCP client (e.g. Claude Code) sends the
// user here to approve it. The answer goes through /api/oauth/authorize.
export const load: PageServerLoad = ({ locals, url }) => {
	const db = getDb();
	const check = checkAuthorizeRequest(db, url.searchParams, url.origin);
	if (!check.ok) {
		if (check.fatal) return { problem: check.message };
		redirect(303, check.redirectTo);
	}
	if (!locals.user) {
		redirect(302, `/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`);
	}
	const { client, redirectUri } = check.request;
	const existing = findOAuthKey(db, locals.user.id, client.id);
	return {
		problem: null,
		query: url.searchParams.toString(),
		client: {
			name: client.name,
			returnTo: new URL(redirectUri).host || redirectUri,
			/** Returns to this machine (loopback): a local CLI such as Claude Code. */
			local: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(redirectUri).hostname)
		},
		user: { name: locals.user.name, email: locals.user.email },
		/** An earlier approval of this client: approving again updates that key. */
		existing: existing
			? { label: existing.label, mcpAccess: parseMcpAccess(existing.mcp_access) }
			: null,
		servers: listMcpGatewayServers(db, locals.user.id)
	};
};
