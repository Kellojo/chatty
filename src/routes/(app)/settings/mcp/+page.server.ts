import { requireUser } from '$lib/server/auth/guards.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/db/index.js';
import { listMcpServersFor, toPublic } from '$lib/server/db/repo/mcp-servers.js';
import {
	getMcpUsageStats,
	MCP_USAGE_WINDOW_DAYS,
	summarizeMcpUsage
} from '$lib/server/db/repo/mcp-tool-usage.js';
import { canManageMcpServer, isAdminActor } from '$lib/server/mcp/access.js';
import { appOrigin, clientMetadataUrl, oauthRedirectUrl } from '$lib/server/mcp/oauth.js';
import { parseUsagePeriod, periodDays } from '$lib/components/app/usage/usage.js';
import type { McpUsageStats } from '$lib/types.js';
import type { PageServerLoad } from './$types';

/**
 * Admins manage the shared servers and their own; everyone else only their own
 * personal servers. Other users' personal servers are never listed, and their
 * usage is left out of the numbers.
 */
export const load: PageServerLoad = ({ locals, url }) => {
	const user = requireUser(locals);
	const isAdmin = isAdminActor(user);
	const origin = appOrigin(url.origin);
	const db = getDb();
	const servers = listMcpServersFor(db, user.id).filter((row) => canManageMcpServer(row, user));
	const listed = new Set(servers.map((row) => row.id));
	const usage = Object.fromEntries(
		Object.entries(summarizeMcpUsage(db)).filter(([id]) => listed.has(id))
	);
	const period = parseUsagePeriod(url.searchParams.get('period'));
	return {
		isAdmin,
		servers: servers.map(toPublic),
		usage,
		usageWindowDays: MCP_USAGE_WINDOW_DAYS,
		/** The Statistics tab (admins only), over the `?period=` it shows. */
		stats: isAdmin
			? { period, ...onlyServers(getMcpUsageStats(db, periodDays(period)), listed) }
			: null,
		/** Non-admins' servers must be reachable on a public address (see mcp/access.ts). */
		publicAddressesOnly: !isAdmin && !config.ALLOW_PRIVATE_NETWORK_FETCH,
		// What to register at an authorization server that needs Chatty set up by hand.
		oauth: { clientMetadataUrl: clientMetadataUrl(origin), redirectUrl: oauthRedirectUrl(origin) }
	};
};

/** The statistics of the listed servers only. */
function onlyServers(stats: McpUsageStats, ids: Set<string>): McpUsageStats {
	const pick = (record: Record<string, number>) =>
		Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)));
	return {
		...stats,
		servers: stats.servers.filter((s) => ids.has(s.serverId)),
		daily: stats.daily.map((d) => ({ ...d, calls: pick(d.calls), errors: pick(d.errors) }))
	};
}
