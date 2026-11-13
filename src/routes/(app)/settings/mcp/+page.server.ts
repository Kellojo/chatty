import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listMcpServers, toPublic } from '$lib/server/db/repo/mcp-servers.js';
import { appOrigin, clientMetadataUrl, oauthRedirectUrl } from '$lib/server/mcp/oauth.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	requireAdmin(locals);
	const origin = appOrigin(url.origin);
	return {
		servers: listMcpServers(getDb()).map(toPublic),
		// What to register at an authorization server that needs Chatty set up by hand.
		oauth: { clientMetadataUrl: clientMetadataUrl(origin), redirectUrl: oauthRedirectUrl(origin) }
	};
};
