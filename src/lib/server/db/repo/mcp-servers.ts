import { randomUUID } from 'node:crypto';
import { encryptSecret } from '../../crypto.js';
import type { Db } from '../index.js';

export type McpTransport = 'builtin' | 'stdio' | 'http' | 'sse';
/** Transports that can be configured through the API (everything but bundled servers). */
export type ConfigurableMcpTransport = Exclude<McpTransport, 'builtin'>;
/** 'deferred' tools stay out of the prompt until the model loads them via search_tools. */
export type McpLoadMode = 'always' | 'deferred';

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
		loadMode: row.load_mode
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
}

export function createMcpServer(db: Db, input: CreateMcpServerInput): McpServerRow {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO mcp_servers (id, name, transport, command, args, url, token_enc, enabled, builtin,
		 load_mode)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
	).run(
		id,
		input.name,
		input.transport,
		input.command ?? null,
		JSON.stringify(input.args ?? []),
		input.url ?? null,
		input.token ? encryptSecret(input.token) : null,
		input.enabled === false ? 0 : 1,
		input.loadMode ?? 'deferred'
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
	db.prepare(
		`UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, url = ?, token_enc = ?,
		 enabled = ?, load_mode = ?
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
		id
	);
	return getMcpServer(db, id);
}

export function deleteMcpServer(db: Db, id: string): boolean {
	const existing = getMcpServer(db, id);
	if (!existing || existing.builtin === 1) return false;
	return db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0;
}
