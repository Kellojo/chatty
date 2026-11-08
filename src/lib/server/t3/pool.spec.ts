import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();

class FakeConnection {
	closed = false;
	private readonly listeners = new Set<(error: Error) => void>();
	onClose(listener: (error: Error) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const listener of this.listeners) listener(new Error('Connection closed'));
	}
}

const connections: FakeConnection[] = [];
let connectImpl: () => Promise<FakeConnection> = async () => {
	const conn = new FakeConnection();
	connections.push(conn);
	return conn;
};
const connectT3 = vi.fn(() => connectImpl());
const { T3ClientError } = await import('./client.js');
vi.doMock('./client.js', () => ({ connectT3, T3ClientError }));
vi.doMock('../crypto.js', () => ({ decryptSecret: (value: string) => `plain:${value}` }));

const {
	POOL_IDLE_MS,
	acquireT3Connection,
	closeAllT3Connections,
	closeT3Connections,
	pooledConnectionCount,
	withT3Connection
} = await import('./pool.js');

const env = { id: 'env1', base_url: 'http://t3.test', token_enc: 'tok' };

beforeEach(() => {
	vi.useFakeTimers();
	connections.length = 0;
	connectT3.mockClear();
	connectImpl = async () => {
		const conn = new FakeConnection();
		connections.push(conn);
		return conn;
	};
});

afterEach(() => {
	closeAllT3Connections();
	vi.useRealTimers();
});

describe('T3 connection pool', () => {
	it('shares one socket between the users of an environment', async () => {
		const a = acquireT3Connection(env);
		const b = acquireT3Connection(env);
		const [ca, cb] = await Promise.all([a.connection(), b.connection()]);
		expect(ca).toBe(cb);
		expect(await withT3Connection(env, async (conn) => conn)).toBe(ca);
		expect(connectT3).toHaveBeenCalledTimes(1);
		expect(connectT3).toHaveBeenCalledWith('http://t3.test', 'plain:tok');
	});

	it('opens separate sockets for other environments and changed credentials', async () => {
		const first = await acquireT3Connection(env).connection();
		const rekeyed = await acquireT3Connection({ ...env, token_enc: 'new' }).connection();
		const other = await acquireT3Connection({ ...env, id: 'env2' }).connection();
		expect(new Set([first, rekeyed, other]).size).toBe(3);
	});

	it('closes the socket a while after its last user released it', async () => {
		const a = acquireT3Connection(env);
		const b = acquireT3Connection(env);
		const conn = await a.connection();
		a.release();
		a.release(); // idempotent: b still holds it
		await vi.advanceTimersByTimeAsync(POOL_IDLE_MS * 2);
		expect(conn.closed).toBe(false);

		b.release();
		await vi.advanceTimersByTimeAsync(POOL_IDLE_MS - 1);
		expect(conn.closed).toBe(false);
		// Taken again before the delay is up: kept.
		const c = acquireT3Connection(env);
		await vi.advanceTimersByTimeAsync(POOL_IDLE_MS);
		expect(await c.connection()).toBe(conn);
		c.release();
		await vi.advanceTimersByTimeAsync(POOL_IDLE_MS);
		expect(conn.closed).toBe(true);
		expect(pooledConnectionCount()).toBe(0);
	});

	it('reconnects once for everyone after the socket closed', async () => {
		const a = acquireT3Connection(env);
		const b = acquireT3Connection(env);
		const first = await a.connection();
		first.close();
		const [ca, cb] = await Promise.all([a.connection(), b.connection()]);
		expect(ca).toBe(cb);
		expect(ca).not.toBe(first);
		expect(connectT3).toHaveBeenCalledTimes(2);
	});

	it('hands a failed connect to everyone waiting on it, and retries on the next call', async () => {
		connectImpl = async () => {
			throw new T3ClientError('Access token was rejected', 'unauthorized');
		};
		const a = acquireT3Connection(env);
		const b = acquireT3Connection(env);
		const results = await Promise.allSettled([a.connection(), b.connection()]);
		expect(connectT3).toHaveBeenCalledTimes(1);
		for (const result of results) {
			expect(result).toMatchObject({
				status: 'rejected',
				reason: { kind: 'unauthorized' }
			});
		}
		connectImpl = async () => new FakeConnection();
		await expect(a.connection()).resolves.toBeInstanceOf(FakeConnection);
	});

	it('closes an environment’s sockets when it changes, failing the leases still held', async () => {
		const held = acquireT3Connection(env);
		const conn = await held.connection();
		const other = await acquireT3Connection({ ...env, id: 'env2' }).connection();

		closeT3Connections('env1');

		expect(conn.closed).toBe(true);
		expect(other.closed).toBe(false);
		await expect(held.connection()).rejects.toThrow(/changed or removed/);
		// A new lease gets a fresh socket.
		const fresh = await acquireT3Connection(env).connection();
		expect(fresh).not.toBe(conn);
	});

	it('does not keep a socket that finished connecting after its environment changed', async () => {
		let resolve!: (conn: FakeConnection) => void;
		connectImpl = () => new Promise((r) => (resolve = r));
		const lease = acquireT3Connection(env);
		const pending = lease.connection();
		closeT3Connections('env1');
		const late = new FakeConnection();
		resolve(late);
		await expect(pending).rejects.toThrow(/changed or removed/);
		expect(late.closed).toBe(true);
	});

	it('closes everything on shutdown', async () => {
		const a = await acquireT3Connection(env).connection();
		const b = await acquireT3Connection({ ...env, id: 'env2' }).connection();
		closeAllT3Connections();
		expect(a.closed && b.closed).toBe(true);
		expect(pooledConnectionCount()).toBe(0);
	});
});
