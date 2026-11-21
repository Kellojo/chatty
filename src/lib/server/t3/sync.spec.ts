import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const call = vi.fn<(tag: string, payload?: unknown) => Promise<unknown>>();
const actualClient = await vi.importActual<typeof import('./client.js')>('./client.js');
vi.doMock('./client.js', () => ({
	...actualClient,
	fetchEnvironmentDescriptor: vi.fn(async () => ({
		orchestrationProtocolVersion: actualClient.ORCHESTRATION_PROTOCOL_VERSION,
		serverVersion: '1.0.0',
		label: 'T3',
		environmentId: 'env-remote'
	}))
}));
vi.doMock('./pool.js', () => ({
	withT3Connection: async (_env: unknown, fn: (conn: { call: typeof call }) => unknown) =>
		fn({ call })
}));
vi.doMock('./follower.js', () => ({ stopFollowersForEnvironment: vi.fn() }));
vi.doMock('./tasks.js', () => ({ resumeCodingTasks: vi.fn() }));
vi.doMock('./thread-sync.js', () => ({
	refreshShellWatchers: vi.fn(),
	startThreadSync: vi.fn(),
	stopThreadSync: vi.fn()
}));

const { getDb, closeDb } = await import('../db/index.js');
const { createCodingEnvironment, getCodingEnvironment } =
	await import('../db/repo/coding-environments.js');
const { syncCodingEnvironment } = await import('./sync.js');
const { T3ClientError } = actualClient;

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'u1', 'u1@example.com', 0, 0, 0, 'user')`
		)
		.run();
	call.mockReset();
});

describe('syncCodingEnvironment', () => {
	it('keeps an environment online when its token cannot read usage history', async () => {
		const db = getDb();
		const env = createCodingEnvironment(db, 'u1', {
			name: 'T3',
			baseUrl: 'http://t3.test',
			token: 'token'
		});
		call.mockImplementation(async (tag) => {
			if (tag === 'server.getUsageSummary') {
				throw new T3ClientError('Token is missing the "diagnostics:read" scope', 'unauthorized');
			}
			return {};
		});
		await syncCodingEnvironment(db, env);
		expect(getCodingEnvironment(db, 'u1', env.id)?.status).toBe('online');
	});

	it('still flags a token rejected for what tasks need', async () => {
		const db = getDb();
		const env = createCodingEnvironment(db, 'u1', {
			name: 'T3',
			baseUrl: 'http://t3.test',
			token: 'token'
		});
		call.mockRejectedValue(
			new T3ClientError('Token is missing the "orchestration:read" scope', 'unauthorized')
		);
		await syncCodingEnvironment(db, env);
		expect(getCodingEnvironment(db, 'u1', env.id)?.status).toBe('unauthorized');
	});
});
