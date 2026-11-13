import { createHash } from 'node:crypto';
import type { Tool } from 'ai';
import type { McpServerRow } from '../db/repo/mcp-servers.js';
import { createLogger } from '../logger.js';
import {
	connectServer,
	MCP_LIST_TIMEOUT_MS,
	withTimeout,
	type ServerConnection
} from './clientManager.js';
import type { CallerContext } from './types.js';

const log = createLogger('mcp-pool');

/** A pooled connection nobody has used for this long is closed. */
export const MCP_IDLE_MS = 10 * 60_000;
/** After a failed connect, the server is skipped for this long instead of retried every turn. */
export const MCP_FAILURE_BACKOFF_MS = 30_000;
const SWEEP_INTERVAL_MS = 60_000;

// External servers don't see the caller (no user, workspace or conversation is
// passed to them), so one connection can serve every user and conversation.
// The exception is OAuth servers: they act as the signed-in user, so each user
// gets their own pooled connection. Builtin servers are bound to their caller
// and are never pooled.
const POOL_CTX: CallerContext = {
	userId: 'mcp-pool',
	role: 'user',
	workspaceDir: null,
	documentsDir: ''
};

interface Entry {
	key: string;
	serverId: string;
	/** Set for per-user (OAuth) connections. */
	userId: string | null;
	ready: Promise<{ conn: ServerConnection; tools: Record<string, Tool> }>;
	leases: number;
	lastUsed: number;
	/** Set once connected, so liveness can be checked synchronously. */
	conn?: ServerConnection;
	/** Dropped from the pool; closed as soon as its last lease is released. */
	evicted: boolean;
	closed: boolean;
}

interface Failure {
	key: string;
	serverId: string;
	userId: string | null;
	until: number;
	error: Error;
}

export interface McpLease {
	/** The server's tools, as listed when the connection was opened. */
	tools: Record<string, Tool>;
	/** Call when the turn is done with the tools. Idempotent. */
	release: () => void;
	/** Call when the connection looks dead; the next acquire reconnects. */
	markBroken: () => void;
}

const entries = new Map<string, Entry>();
/** By connection slot (server, plus user for OAuth servers). */
const failures = new Map<string, Failure>();
/**
 * The tools each server listed on its last successful connect, by pool key.
 * They outlive idle connections, so a turn can offer a server's tools without
 * connecting and only connect when one of them is called.
 */
const catalogs = new Map<
	string,
	{ serverId: string; userId: string | null; tools: Record<string, Tool> }
>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Identifies a server's connection settings: an edit yields a new key, so stale clients are never reused. */
export function poolKey(row: McpServerRow, userId?: string | null): string {
	const hash = createHash('sha256')
		.update(
			JSON.stringify([
				row.transport,
				row.command,
				row.args,
				row.url,
				row.token_enc ?? null,
				row.auth ?? 'token',
				row.oauth_client_id ?? null,
				row.oauth_scope ?? null
			])
		)
		.digest('hex')
		.slice(0, 16);
	const user = connectionUser(row, userId);
	return user ? `${row.id}:${hash}:${user}` : `${row.id}:${hash}`;
}

/** The user a connection to this server acts as: only OAuth servers have one. */
function connectionUser(row: McpServerRow, userId?: string | null): string | null {
	if (row.auth !== 'oauth') return null;
	if (!userId) throw new Error(`MCP server ${row.name} needs a signed-in user`);
	return userId;
}

/** Failures and settings changes are tracked per connection slot. */
function slotId(serverId: string, userId: string | null): string {
	return userId ? `${serverId}:${userId}` : serverId;
}

function isClientClosed(conn: ServerConnection): boolean {
	// DefaultMCPClient tracks this internally; it flips when the transport closes.
	return (conn.client as unknown as { isClosed?: boolean }).isClosed === true;
}

function closeEntry(entry: Entry): void {
	if (entry.closed) return;
	entry.closed = true;
	entry.ready.then(
		({ conn }) =>
			conn.close().catch((e) =>
				log.warn(`Closing pooled MCP client ${entry.serverId} failed`, {
					error: e instanceof Error ? e.message : String(e)
				})
			),
		() => undefined
	);
}

function evict(entry: Entry): void {
	if (entries.get(entry.key) === entry) entries.delete(entry.key);
	entry.evicted = true;
	if (entry.leases === 0) closeEntry(entry);
}

function ensureSweep(): void {
	if (sweepTimer) return;
	sweepTimer = setInterval(() => sweepIdleMcpClients(), SWEEP_INTERVAL_MS);
	sweepTimer.unref?.();
}

/** Closes pooled connections idle for longer than `idleMs`. Returns how many were closed. */
export function sweepIdleMcpClients(now = Date.now(), idleMs = MCP_IDLE_MS): number {
	let closed = 0;
	for (const entry of [...entries.values()]) {
		if (entry.leases > 0 || now - entry.lastUsed < idleMs) continue;
		evict(entry);
		closed++;
	}
	for (const [id, failure] of failures) if (failure.until <= now) failures.delete(id);
	if (entries.size === 0 && sweepTimer) {
		clearInterval(sweepTimer);
		sweepTimer = null;
	}
	return closed;
}

function open(row: McpServerRow, key: string, userId: string | null): Entry {
	const connect = async () => {
		const conn = await connectServer(row, userId ? { ...POOL_CTX, userId } : POOL_CTX);
		try {
			const tools = (await withTimeout(
				conn.client.tools(),
				`Listing tools of MCP server ${row.name}`,
				undefined,
				MCP_LIST_TIMEOUT_MS
			)) as unknown as Record<string, Tool>;
			return { conn, tools };
		} catch (e) {
			await conn.close().catch(() => undefined);
			throw e;
		}
	};
	const entry: Entry = {
		key,
		serverId: row.id,
		userId,
		leases: 0,
		lastUsed: Date.now(),
		evicted: false,
		closed: false,
		ready: connect()
	};
	entry.ready.then(
		({ conn, tools }) => {
			entry.conn = conn;
			catalogs.set(key, { serverId: row.id, userId, tools });
		},
		() => undefined
	);
	entry.ready.catch((e: unknown) => {
		if (entries.get(key) === entry) entries.delete(key);
		failures.set(slotId(row.id, userId), {
			key,
			serverId: row.id,
			userId,
			until: Date.now() + MCP_FAILURE_BACKOFF_MS,
			error: e instanceof Error ? e : new Error(String(e))
		});
	});
	return entry;
}

/**
 * Leases a pooled connection to an external (non-builtin) MCP server, opening
 * one if needed. Concurrent callers share one connect. A server that just
 * failed to connect is not retried until the backoff expires.
 */
export async function acquireMcpServer(
	row: McpServerRow,
	userId?: string | null
): Promise<McpLease> {
	if (row.transport === 'builtin') throw new Error('Builtin MCP servers are not pooled');
	const user = connectionUser(row, userId);
	const key = poolKey(row, user);
	// Settings changed: connections under the old settings are never used again.
	for (const entry of [...entries.values()]) {
		if (entry.serverId === row.id && entry.userId === user && entry.key !== key) evict(entry);
	}
	const slot = slotId(row.id, user);
	const failure = failures.get(slot);
	if (failure) {
		if (failure.key === key && failure.until > Date.now()) throw failure.error;
		failures.delete(slot);
	}
	let entry = entries.get(key);
	if (entry) {
		// A connection that died while idle is replaced rather than handed out.
		if (entry.conn && isClientClosed(entry.conn)) {
			evict(entry);
			entry = undefined;
		}
	}
	if (!entry) {
		entry = open(row, key, user);
		entries.set(key, entry);
		ensureSweep();
	}
	const current = entry;
	current.leases++;
	current.lastUsed = Date.now();
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		current.leases--;
		current.lastUsed = Date.now();
		if (current.evicted && current.leases === 0) closeEntry(current);
	};
	try {
		const { tools } = await current.ready;
		return { tools, release, markBroken: () => evict(current) };
	} catch (e) {
		release();
		throw e;
	}
}

/**
 * The tools a server listed when it last connected under its current
 * settings, or undefined if it never did or its last connect just failed.
 * Their `execute` belongs to that connection: call tools through a lease.
 */
export function cachedMcpTools(
	row: McpServerRow,
	userId?: string | null
): Record<string, Tool> | undefined {
	const user = connectionUser(row, userId);
	const key = poolKey(row, user);
	const failure = failures.get(slotId(row.id, user));
	if (failure && failure.key === key && failure.until > Date.now()) return undefined;
	return catalogs.get(key)?.tools;
}

/** Drops (and closes, once idle) every pooled connection of a server, e.g. after it was edited or deleted. */
export function invalidateMcpServer(serverId: string): void {
	for (const [slot, failure] of failures) if (failure.serverId === serverId) failures.delete(slot);
	for (const [key, catalog] of catalogs) if (catalog.serverId === serverId) catalogs.delete(key);
	for (const entry of [...entries.values()]) {
		if (entry.serverId === serverId) evict(entry);
	}
}

/** Drops one user's connection to an OAuth server, e.g. after they signed in or out. */
export function invalidateMcpServerForUser(serverId: string, userId: string): void {
	failures.delete(slotId(serverId, userId));
	for (const [key, catalog] of catalogs) {
		if (catalog.serverId === serverId && catalog.userId === userId) catalogs.delete(key);
	}
	for (const entry of [...entries.values()]) {
		if (entry.serverId === serverId && entry.userId === userId) evict(entry);
	}
}

/** Closes every pooled connection (on shutdown); waits for the closes to finish. */
export async function closeAllMcpClients(): Promise<void> {
	const all = [...entries.values()];
	entries.clear();
	failures.clear();
	catalogs.clear();
	if (sweepTimer) clearInterval(sweepTimer);
	sweepTimer = null;
	await Promise.all(
		all.map(async (entry) => {
			entry.evicted = true;
			if (entry.closed) return;
			entry.closed = true;
			const ready = await entry.ready.catch(() => null);
			await ready?.conn.close().catch(() => undefined);
		})
	);
}

/** Number of live pooled connections (for tests and diagnostics). */
export function pooledMcpClientCount(): number {
	return entries.size;
}
