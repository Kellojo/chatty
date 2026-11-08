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
// Builtin servers are bound to their caller and are never pooled.
const POOL_CTX: CallerContext = {
	userId: 'mcp-pool',
	role: 'user',
	workspaceDir: null,
	documentsDir: ''
};

interface Entry {
	key: string;
	serverId: string;
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
const failures = new Map<string, Failure>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Identifies a server's connection settings: an edit yields a new key, so stale clients are never reused. */
export function poolKey(row: McpServerRow): string {
	const hash = createHash('sha256')
		.update(JSON.stringify([row.transport, row.command, row.args, row.url, row.token_enc ?? null]))
		.digest('hex')
		.slice(0, 16);
	return `${row.id}:${hash}`;
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

function open(row: McpServerRow, key: string): Entry {
	const connect = async () => {
		const conn = await connectServer(row, POOL_CTX);
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
		leases: 0,
		lastUsed: Date.now(),
		evicted: false,
		closed: false,
		ready: connect()
	};
	entry.ready.then(
		({ conn }) => (entry.conn = conn),
		() => undefined
	);
	entry.ready.catch((e: unknown) => {
		if (entries.get(key) === entry) entries.delete(key);
		failures.set(row.id, {
			key,
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
export async function acquireMcpServer(row: McpServerRow): Promise<McpLease> {
	if (row.transport === 'builtin') throw new Error('Builtin MCP servers are not pooled');
	const key = poolKey(row);
	// Settings changed: connections under the old settings are never used again.
	for (const entry of [...entries.values()]) {
		if (entry.serverId === row.id && entry.key !== key) evict(entry);
	}
	const failure = failures.get(row.id);
	if (failure) {
		if (failure.key === key && failure.until > Date.now()) throw failure.error;
		failures.delete(row.id);
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
		entry = open(row, key);
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

/** Drops (and closes, once idle) every pooled connection of a server, e.g. after it was edited or deleted. */
export function invalidateMcpServer(serverId: string): void {
	failures.delete(serverId);
	for (const entry of [...entries.values()]) {
		if (entry.serverId === serverId) evict(entry);
	}
}

/** Closes every pooled connection (on shutdown); waits for the closes to finish. */
export async function closeAllMcpClients(): Promise<void> {
	const all = [...entries.values()];
	entries.clear();
	failures.clear();
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
