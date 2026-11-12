import { randomUUID } from 'node:crypto';
import { encryptSecret } from '../../crypto.js';
import type { Db } from '../index.js';

export type McpTransport = 'builtin' | 'stdio' | 'http' | 'sse';
/** Transports that can be configured through the API (everything but bundled servers). */
export type ConfigurableMcpTransport = Exclude<McpTransport, 'builtin'>;
/** 'deferred' tools stay out of the prompt until the model loads them via search_tools. */
export type McpLoadMode = 'always' | 'deferred';
/** 'token': an optional static bearer token; 'oauth': each user signs in (http/sse only). */
export type McpAuth = 'token' | 'oauth';

export interface McpServerRow {
	id: string;
	name: string;
	transport: McpTransport;
	command: string | null;
	args: string;
	url: string | null;
	token_enc: string | null;
	enabled: number;
	builtin: number;
	load_mode: McpLoadMode;
	auth: McpAuth;
	oauth_client_id: string | null;
	oauth_client_secret_enc: string | null;
	oauth_scope: string | null;
	oauth_client_info_enc: string | null;
}

export interface McpServer {
	id: string;
	name: string;
	transport: McpTransport;
	url: string | null;
	command: string | null;
	args: string[];
	hasToken: boolean;
	enabled: boolean;
	builtin: boolean;
	loadMode: McpLoadMode;
	auth: McpAuth;
	/** OAuth: a client registered by hand at the authorization server (null: automatic). */
	oauthClientId: string | null;
	hasOauthClientSecret: boolean;
	oauthScope: string | null;
}

/** Parses the JSON `args` column, tolerating malformed values. */
export function parseMcpArgs(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
	} catch {
		return [];
	}
}

export function toPublic(row: McpServerRow): McpServer {
	return {
		id: row.id,
		name: row.name,
		transport: row.transport,
		url: row.url,
		command: row.command,
		args: parseMcpArgs(row.args),
		hasToken: row.token_enc != null && row.token_enc.length > 0,
		enabled: row.enabled === 1,
		builtin: row.builtin === 1,
		loadMode: row.load_mode,
		auth: row.auth,
		oauthClientId: row.oauth_client_id,
		hasOauthClientSecret: !!row.oauth_client_secret_enc,
		oauthScope: row.oauth_scope
	};
}

export function listMcpServers(db: Db): McpServerRow[] {
	return db
		.prepare('SELECT * FROM mcp_servers ORDER BY builtin DESC, name')
		.all() as McpServerRow[];
}

export function listEnabledMcpServers(db: Db): McpServerRow[] {
	return listMcpServers(db).filter((row) => row.enabled === 1);
}

export function getMcpServer(db: Db, id: string): McpServerRow | undefined {
	return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
}

export interface CreateMcpServerInput {
	name: string;
	transport: ConfigurableMcpTransport;
	url?: string | null;
	token?: string | null;
	command?: string | null;
	args?: string[];
	enabled?: boolean;
	/** Defaults to 'deferred': external servers often bring many tools. */
	loadMode?: McpLoadMode;
	auth?: McpAuth;
	oauthClientId?: string | null;
	oauthClientSecret?: string | null;
	oauthScope?: string | null;
}

export function createMcpServer(db: Db, input: CreateMcpServerInput): McpServerRow {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO mcp_servers (id, name, transport, command, args, url, token_enc, enabled, builtin,
		 load_mode, auth, oauth_client_id, oauth_client_secret_enc, oauth_scope)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
	).run(
		id,
		input.name,
		input.transport,
		input.command ?? null,
		JSON.stringify(input.args ?? []),
		input.url ?? null,
		input.token ? encryptSecret(input.token) : null,
		input.enabled === false ? 0 : 1,
		input.loadMode ?? 'deferred',
		input.auth ?? 'token',
		input.oauthClientId ?? null,
		input.oauthClientSecret ? encryptSecret(input.oauthClientSecret) : null,
		input.oauthScope ?? null
	);
	return getMcpServer(db, id)!;
}

export interface UpdateMcpServerInput {
	name?: string;
	transport?: ConfigurableMcpTransport;
	url?: string | null;
	token?: string | null;
	command?: string | null;
	args?: string[];
	enabled?: boolean;
	loadMode?: McpLoadMode;
	auth?: McpAuth;
	oauthClientId?: string | null;
	oauthClientSecret?: string | null;
	oauthScope?: string | null;
}

export function updateMcpServer(
	db: Db,
	id: string,
	patch: UpdateMcpServerInput
): McpServerRow | undefined {
	const existing = getMcpServer(db, id);
	if (!existing) return undefined;
	const isBuiltin = existing.builtin === 1;
	const editable = <K extends keyof UpdateMcpServerInput>(key: K) =>
		!isBuiltin && patch[key] !== undefined;
	const reRegister = oauthRegistrationChanged(existing, patch);
	if (reRegister) {
		// Tokens were issued for the old URL and client: never send them anywhere else.
		db.prepare('DELETE FROM mcp_oauth_sessions WHERE server_id = ?').run(id);
	}
	db.prepare(
		`UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, url = ?, token_enc = ?,
		 enabled = ?, load_mode = ?, auth = ?, oauth_client_id = ?, oauth_client_secret_enc = ?,
		 oauth_scope = ?, oauth_client_info_enc = ?
		 WHERE id = ?`
	).run(
		editable('name') ? patch.name : existing.name,
		editable('transport') ? patch.transport : existing.transport,
		editable('command') ? patch.command : existing.command,
		editable('args') ? JSON.stringify(patch.args) : existing.args,
		editable('url') ? patch.url : existing.url,
		editable('token') ? (patch.token ? encryptSecret(patch.token) : null) : existing.token_enc,
		patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
		patch.loadMode ?? existing.load_mode,
		editable('auth') ? patch.auth : existing.auth,
		editable('oauthClientId') ? patch.oauthClientId : existing.oauth_client_id,
		editable('oauthClientSecret')
			? patch.oauthClientSecret
				? encryptSecret(patch.oauthClientSecret)
				: null
			: existing.oauth_client_secret_enc,
		editable('oauthScope') ? patch.oauthScope : existing.oauth_scope,
		// A registration belongs to one server URL and client setup: re-register after either changes.
		reRegister ? null : existing.oauth_client_info_enc,
		id
	);
	return getMcpServer(db, id);
}

function oauthRegistrationChanged(existing: McpServerRow, patch: UpdateMcpServerInput): boolean {
	if (existing.builtin === 1) return false;
	return (
		(patch.url !== undefined && patch.url !== existing.url) ||
		(patch.auth !== undefined && patch.auth !== existing.auth) ||
		(patch.oauthClientId !== undefined && patch.oauthClientId !== existing.oauth_client_id) ||
		patch.oauthClientSecret !== undefined
	);
}

/** Stores the OAuth client registration in use for a server (null clears it). */
export function setMcpOAuthClientInfo(db: Db, id: string, infoJson: string | null): void {
	db.prepare('UPDATE mcp_servers SET oauth_client_info_enc = ? WHERE id = ?').run(
		infoJson ? encryptSecret(infoJson) : null,
		id
	);
}

export function deleteMcpServer(db: Db, id: string): boolean {
	const existing = getMcpServer(db, id);
	if (!existing || existing.builtin === 1) return false;
	return db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0;
}
