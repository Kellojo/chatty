/**
 * Who may use and manage which MCP server. A shared server (no owner) is offered to
 * every user and managed by admins. A personal server is offered to its owner only,
 * who manages it.
 *
 * Personal servers of non-admins are user input like a URL handed to the fetch
 * tools: Chatty only connects to them on public addresses (unless
 * ALLOW_PRIVATE_NETWORK_FETCH is set), so a user can't make it reach the LAN,
 * localhost or cloud metadata. Admins' servers may live anywhere, as before.
 */
import { error } from '@sveltejs/kit';
import type { Db } from '../db/index.js';
import { getMcpServer, isMcpServerVisibleTo, type McpServerRow } from '../db/repo/mcp-servers.js';
import { safeFetch } from '../net/safeFetch.js';

export interface McpActor {
	id: string;
	role?: string | null;
}

export const isAdminActor = (actor: McpActor) => actor.role === 'admin';

/** Whether `actor` may edit, test, delete and see the usage of a server. */
export function canManageMcpServer(
	row: Pick<McpServerRow, 'owner_user_id'>,
	actor: McpActor
): boolean {
	if (row.owner_user_id != null) return row.owner_user_id === actor.id;
	return isAdminActor(actor);
}

/**
 * The server, if `actor` may manage it. Other users' personal servers answer 404,
 * as if they didn't exist; shared servers answer 403 to non-admins.
 */
export function requireManageableMcpServer(db: Db, id: string, actor: McpActor): McpServerRow {
	const row = getMcpServer(db, id);
	if (!row || !isMcpServerVisibleTo(row, actor.id)) error(404, { message: 'Server not found' });
	if (!canManageMcpServer(row, actor)) error(403, { message: 'Admin required' });
	return row;
}

/** Whether connections to the server must stay on public addresses: a non-admin's personal server. */
export function isNetworkRestricted(db: Db, row: Pick<McpServerRow, 'owner_user_id'>): boolean {
	if (row.owner_user_id == null) return false;
	const owner = db.prepare('SELECT role FROM "user" WHERE id = ?').get(row.owner_user_id) as
		{ role: string | null } | undefined;
	return owner?.role !== 'admin';
}

/**
 * `fetch` that only reaches public addresses: every request and redirect hop is
 * checked when it connects (see safeFetch), so DNS rebinding can't get around it.
 */
export const publicOnlyFetch: typeof fetch = (input, init) => {
	if (input instanceof Request) {
		return safeFetch(input.url, {
			method: input.method,
			headers: input.headers,
			body: input.body,
			signal: input.signal,
			duplex: 'half',
			...init
		} as RequestInit);
	}
	return safeFetch(input instanceof URL ? input.href : input, init);
};

/** The fetch a server's connections and OAuth requests must use, or undefined when unrestricted. */
export function restrictedFetchFor(
	db: Db,
	row: Pick<McpServerRow, 'owner_user_id'>
): typeof fetch | undefined {
	return isNetworkRestricted(db, row) ? publicOnlyFetch : undefined;
}
