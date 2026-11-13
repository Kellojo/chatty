import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listMcpServers, toPublic } from '$lib/server/db/repo/mcp-servers.js';
import {
	getMcpUsageStats,
	MCP_USAGE_WINDOW_DAYS,
	summarizeMcpUsage
} from '$lib/server/db/repo/mcp-tool-usage.js';
import { appOrigin, clientMetadataUrl, oauthRedirectUrl } from '$lib/server/mcp/oauth.js';
import { parseUsagePeriod, periodDays } from '$lib/components/app/usage/usage.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	requireAdmin(locals);
	const origin = appOrigin(url.origin);
	const db = getDb();
	const period = parseUsagePeriod(url.searchParams.get('period'));
	return {
		servers: listMcpServers(db).map(toPublic),
		usage: summarizeMcpUsage(db),
		usageWindowDays: MCP_USAGE_WINDOW_DAYS,
		/** The Statistics tab, over the `?period=` it shows. */
		stats: { period, ...getMcpUsageStats(db, periodDays(period)) },
		// What to register at an authorization server that needs Chatty set up by hand.
		oauth: { clientMetadataUrl: clientMetadataUrl(origin), redirectUrl: oauthRedirectUrl(origin) }
	};
};
