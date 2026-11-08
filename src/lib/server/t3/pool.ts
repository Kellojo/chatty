// Shared RPC sockets to T3 Code servers: one per environment (its id, URL and
// token), however many followers, shell watchers and one-off calls use it.
// `T3Connection` already multiplexes calls and streams, so this only counts
// users and decides when a socket opens and closes:
// - opened lazily by the first `connection()` call, and again after it closed
//   (one attempt shared by everyone asking at the same time; its failure
//   reaches all of them);
// - users watch `conn.onClose` themselves and keep their own retry policy;
// - closed POOL_IDLE_MS after the last user released it, right away when the
//   environment changes or goes away (`closeT3Connections`), and on shutdown.

import { decryptSecret } from '../crypto.js';
import type { CodingEnvironmentRow } from '../db/repo/coding-environments.js';
import { connectT3, T3ClientError, type T3Connection } from './client.js';

/** How long an unused socket stays open (the preview panel polls every few seconds). */
export const POOL_IDLE_MS = 15_000;

export type T3EnvironmentRef = Pick<CodingEnvironmentRow, 'id' | 'base_url' | 'token_enc'>;

export interface T3Lease {
	/** The environment's open socket, connecting (or reconnecting) if needed. */
	connection(): Promise<T3Connection>;
	/** Gives the socket back; idempotent. Streams the user opened must be cancelled first. */
	release(): void;
}

const retiredError = () =>
	new T3ClientError('The coding environment was changed or removed', 'protocol');

class PoolEntry {
	refs = 0;
	retired = false;
	private conn: T3Connection | null = null;
	private connecting: Promise<T3Connection> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly key: string,
		readonly env: T3EnvironmentRef
	) {}

	connection(): Promise<T3Connection> {
		if (this.retired) return Promise.reject(retiredError());
		if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
		this.connecting ??= this.open().finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	private async open(): Promise<T3Connection> {
		const conn = await connectT3(this.env.base_url, decryptSecret(this.env.token_enc));
		if (this.retired) {
			conn.close();
			throw retiredError();
		}
		this.conn = conn;
		conn.onClose(() => {
			if (this.conn === conn) this.conn = null;
		});
		return conn;
	}

	acquire(): void {
		this.refs++;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	release(): void {
		this.refs--;
		if (this.refs > 0 || this.retired) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (this.refs === 0) retire(this);
		}, POOL_IDLE_MS);
		this.idleTimer.unref?.();
	}

	close(): void {
		this.retired = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		const conn = this.conn;
		this.conn = null;
		conn?.close();
	}
}

const entries = new Map<string, PoolEntry>();

const keyOf = (env: T3EnvironmentRef) => `${env.id}\n${env.base_url}\n${env.token_enc}`;

function retire(entry: PoolEntry): void {
	if (entries.get(entry.key) === entry) entries.delete(entry.key);
	entry.close();
}

/**
 * Takes a share of `env`'s socket. A changed URL or token is a different
 * socket, so users holding the old one never get the new credentials.
 */
export function acquireT3Connection(env: T3EnvironmentRef): T3Lease {
	const key = keyOf(env);
	let entry = entries.get(key);
	if (!entry) {
		entry = new PoolEntry(key, env);
		entries.set(key, entry);
	}
	entry.acquire();
	const held = entry;
	let released = false;
	return {
		connection: () => (released ? Promise.reject(retiredError()) : held.connection()),
		release: () => {
			if (released) return;
			released = true;
			held.release();
		}
	};
}

/** Runs `fn` with `env`'s shared socket (never close it). */
export async function withT3Connection<T>(
	env: T3EnvironmentRef,
	fn: (conn: T3Connection) => Promise<T>
): Promise<T> {
	const lease = acquireT3Connection(env);
	try {
		return await fn(await lease.connection());
	} finally {
		lease.release();
	}
}

/**
 * Closes every socket of an environment that was edited, disabled or removed.
 * Leases still held on them fail from now on; new ones open a fresh socket.
 */
export function closeT3Connections(environmentId: string): void {
	for (const entry of [...entries.values()]) {
		if (entry.env.id === environmentId) retire(entry);
	}
}

/** Closes every socket (shutdown, tests). */
export function closeAllT3Connections(): void {
	for (const entry of [...entries.values()]) retire(entry);
}

/** Open (or opening) pooled sockets, for tests and diagnostics. */
export function pooledConnectionCount(): number {
	return entries.size;
}
