import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listConnectedMcpServerIds } from '$lib/server/db/repo/mcp-oauth-sessions.js';
import { listEnabledMcpServers } from '$lib/server/db/repo/mcp-servers.js';
import type { McpConnectionInfo } from '$lib/types.js';
import type { PageServerLoad } from './$types';

/** The OAuth MCP servers the user can connect their own account to. */
export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	const connected = listConnectedMcpServerIds(db, user.id);
	const connections: McpConnectionInfo[] = listEnabledMcpServers(db)
		.filter((row) => row.auth === 'oauth' && row.url)
		.map((row) => ({
			id: row.id,
			name: row.name,
			url: row.url!,
			connected: connected.has(row.id)
		}));
	return { connections, isAdmin: (user as { role?: string }).role === 'admin' };
};
