import type { Db } from '../index.js';

/** One user's OAuth state for one MCP server (secrets are encrypted by the caller). */
export interface McpOAuthSessionRow {
	server_id: string;
	user_id: string;
	tokens_enc: string | null;
	code_verifier_enc: string | null;
	state: string | null;
	auth_server_info: string | null;
	updated_at: number;
}

type SessionField = 'tokens_enc' | 'code_verifier_enc' | 'state' | 'auth_server_info';

export function getMcpOAuthSession(
	db: Db,
	serverId: string,
	userId: string
): McpOAuthSessionRow | undefined {
	return db
		.prepare('SELECT * FROM mcp_oauth_sessions WHERE server_id = ? AND user_id = ?')
		.get(serverId, userId) as McpOAuthSessionRow | undefined;
}

/** The sign-in in progress that issued `state` (unique per session). */
export function getMcpOAuthSessionByState(db: Db, state: string): McpOAuthSessionRow | undefined {
	return db.prepare('SELECT * FROM mcp_oauth_sessions WHERE state = ?').get(state) as
		McpOAuthSessionRow | undefined;
}

/** Sets some fields of a user's session, creating the row if needed. */
export function updateMcpOAuthSession(
	db: Db,
	serverId: string,
	userId: string,
	fields: Partial<Record<SessionField, string | null>>
): void {
	const entries = Object.entries(fields) as [SessionField, string | null][];
	if (entries.length === 0) return;
	const columns = entries.map(([column]) => column);
	db.prepare(
		`INSERT INTO mcp_oauth_sessions (server_id, user_id, ${columns.join(', ')}, updated_at)
		 VALUES (?, ?, ${columns.map(() => '?').join(', ')}, ?)
		 ON CONFLICT(server_id, user_id) DO UPDATE SET
		 ${columns.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`
	).run(serverId, userId, ...entries.map(([, value]) => value), Date.now());
}

export function deleteMcpOAuthSession(db: Db, serverId: string, userId: string): boolean {
	return (
		db
			.prepare('DELETE FROM mcp_oauth_sessions WHERE server_id = ? AND user_id = ?')
			.run(serverId, userId).changes > 0
	);
}

/** Forgets every user's tokens for a server, e.g. after its client registration changed. */
export function deleteMcpOAuthSessionsForServer(db: Db, serverId: string): void {
	db.prepare('DELETE FROM mcp_oauth_sessions WHERE server_id = ?').run(serverId);
}

/** Ids of the servers the user holds tokens for. */
export function listConnectedMcpServerIds(db: Db, userId: string): Set<string> {
	const rows = db
		.prepare(
			'SELECT server_id FROM mcp_oauth_sessions WHERE user_id = ? AND tokens_enc IS NOT NULL'
		)
		.all(userId) as { server_id: string }[];
	return new Set(rows.map((r) => r.server_id));
}
