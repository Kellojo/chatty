import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../index.js');
const { decryptSecret } = await import('../../crypto.js');
const repo = await import('./coding-environments.js');
const conversations = await import('./conversations.js');
const coding = await import('./coding-conversations.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;

function addUser(id: string) {
	const now = Date.now();
	db.prepare(
		`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, ?, ?, 'user')`
	).run(id, id, `${id}@example.com`, now, now);
}

beforeEach(() => {
	db = openDatabase(':memory:');
	addUser('u1');
	addUser('u2');
});

const limit = (overrides: Record<string, unknown> = {}) => ({
	accountId: 'claude-main',
	provider: 'claudeAgent',
	accountLabel: 'Claude',
	accountEmail: null,
	accountPlan: null,
	windowId: 'five_hour',
	windowKind: 'session' as const,
	windowLabel: 'Session',
	usedPercent: 40,
	resetsAt: null,
	checkedAt: 1,
	...overrides
});

const bucket = (overrides: Record<string, unknown> = {}) => ({
	day: '2026-11-06',
	provider: 'claude',
	model: 'opus',
	inputTokens: 10,
	cachedInputTokens: 0,
	cacheCreationTokens: 0,
	outputTokens: 5,
	reasoningTokens: 0,
	costUsd: 0.5,
	priced: true,
	sessions: 1,
	...overrides
});

describe('coding environments repo', () => {
	it('encrypts the token and never exposes it publicly', () => {
		const row = repo.createCodingEnvironment(db, 'u1', {
			name: 'devbox',
			baseUrl: 'https://devbox.example/',
			token: 'secret-token'
		});
		expect(row.base_url).toBe('https://devbox.example');
		expect(row.token_enc).not.toContain('secret-token');
		expect(decryptSecret(row.token_enc)).toBe('secret-token');
		expect(JSON.stringify(repo.toPublic(row))).not.toContain('secret');
		expect(repo.toPublic(row)).toMatchObject({ status: 'unknown', enabled: true });
	});

	it('scopes reads, updates and deletes to the owner', () => {
		const row = repo.createCodingEnvironment(db, 'u1', {
			name: 'a',
			baseUrl: 'http://a',
			token: 't'
		});
		expect(repo.listCodingEnvironments(db, 'u2')).toEqual([]);
		expect(repo.getCodingEnvironment(db, 'u2', row.id)).toBeUndefined();
		expect(repo.updateCodingEnvironment(db, 'u2', row.id, { name: 'x' })).toBeUndefined();
		expect(repo.deleteCodingEnvironment(db, 'u2', row.id)).toBeUndefined();
		expect(repo.deleteCodingEnvironment(db, 'u1', row.id)).toBeDefined();
	});

	it('resets status when the connection details change', () => {
		const row = repo.createCodingEnvironment(db, 'u1', {
			name: 'a',
			baseUrl: 'http://a',
			token: 't'
		});
		repo.recordEnvironmentCheck(db, row.id, { status: 'error', error: 'nope' });
		const renamed = repo.updateCodingEnvironment(db, 'u1', row.id, { name: 'b' })!;
		expect(renamed).toMatchObject({ status: 'error', last_error: 'nope' });
		const moved = repo.updateCodingEnvironment(db, 'u1', row.id, { baseUrl: 'http://c' })!;
		expect(moved).toMatchObject({ status: 'unknown', last_error: null, token_enc: row.token_enc });
	});

	it('records checks and sync time', () => {
		const row = repo.createCodingEnvironment(db, 'u1', {
			name: 'a',
			baseUrl: 'http://a',
			token: 't'
		});
		repo.recordEnvironmentCheck(db, row.id, {
			status: 'online',
			serverVersion: '0.1.7',
			environmentLabel: 'devbox',
			synced: true
		});
		const synced = repo.getCodingEnvironment(db, 'u1', row.id)!;
		expect(synced).toMatchObject({
			status: 'online',
			server_version: '0.1.7',
			environment_label: 'devbox'
		});
		expect(synced.last_synced_at).not.toBeNull();
		repo.recordEnvironmentCheck(db, row.id, { status: 'error', error: 'down' });
		const failed = repo.getCodingEnvironment(db, 'u1', row.id)!;
		expect(failed).toMatchObject({
			status: 'error',
			server_version: '0.1.7',
			last_synced_at: synced.last_synced_at
		});
	});

	it('replaces limit windows and lists them per user', () => {
		const row = repo.createCodingEnvironment(db, 'u1', {
			name: 'a',
			baseUrl: 'http://a',
			token: 't'
		});
		repo.replaceUsageLimits(db, row.id, [
			limit(),
			limit({ windowId: 'seven_day', windowKind: 'weekly' })
		]);
		repo.replaceUsageLimits(db, row.id, [limit({ usedPercent: 55 })]);
		const limits = repo.listUsageLimits(db, 'u1');
		expect(limits).toHaveLength(1);
		expect(limits[0]).toMatchObject({ environmentId: row.id, usedPercent: 55 });
		expect(repo.listUsageLimits(db, 'u2')).toEqual([]);
	});

	it('replaces daily buckets within the synced range and sums duplicates', () => {
		const row = repo.createCodingEnvironment(db, 'u1', {
			name: 'a',
			baseUrl: 'http://a',
			token: 't'
		});
		repo.replaceUsageDaily(db, row.id, { fromDay: '2026-10-01', toDay: '2026-10-31' }, [
			bucket({ day: '2026-10-01' })
		]);
		repo.replaceUsageDaily(db, row.id, { fromDay: '2026-11-01', toDay: '2026-11-07' }, [
			bucket(),
			bucket({ inputTokens: 20, costUsd: 1, priced: false })
		]);
		const daily = repo.listUsageDaily(db, 'u1', '2026-01-01');
		expect(daily.map((d) => d.day)).toEqual(['2026-10-01', '2026-11-06']);
		expect(daily[1]).toMatchObject({ inputTokens: 30, costUsd: 1.5, priced: false, sessions: 2 });
		expect(repo.listUsageDaily(db, 'u1', '2026-11-01')).toHaveLength(1);
	});

	it('drops synced usage with the environment', () => {
		const row = repo.createCodingEnvironment(db, 'u1', {
			name: 'a',
			baseUrl: 'http://a',
			token: 't'
		});
		repo.replaceUsageLimits(db, row.id, [limit()]);
		repo.replaceUsageDaily(db, row.id, { fromDay: '2026-11-01', toDay: '2026-11-07' }, [bucket()]);
		repo.deleteCodingEnvironment(db, 'u1', row.id);
		expect(repo.listUsageLimits(db, 'u1')).toEqual([]);
		expect(repo.listUsageDaily(db, 'u1', '2026-01-01')).toEqual([]);
	});

	it('settles and ends its tasks when the environment is removed', () => {
		const env = repo.createCodingEnvironment(db, 'u1', {
			name: 'a',
			baseUrl: 'http://a',
			token: 't'
		});
		const task = (status: 'running' | 'idle', settled = false) => {
			const c = conversations.createConversation(db, 'u1', { title: status });
			coding.createCodingConversation(db, {
				conversationId: c.id,
				environmentId: env.id,
				projectId: 'p',
				projectTitle: 'P',
				providerInstanceId: 'codex',
				model: 'm',
				runtimeMode: 'full-access',
				workspaceMode: 'worktree',
				baseBranch: null
			});
			coding.updateCodingConversation(db, c.id, {
				status,
				runStartedAt: status === 'running' ? 1 : null
			});
			if (settled) conversations.settleConversation(db, 'u1', c.id);
			return c.id;
		};
		const running = task('running');
		const idle = task('idle');
		const alreadySettled = task('idle', true);

		const result = repo.deleteCodingEnvironment(db, 'u1', env.id)!;
		expect(result.endedIds).toEqual([running]);
		expect(result.settledIds.sort()).toEqual([running, idle].sort());
		expect(result.taskIds).toHaveLength(3);
		for (const id of [running, idle, alreadySettled]) {
			expect(conversations.getConversation(db, 'u1', id)?.settled_at).not.toBeNull();
			expect(coding.getCodingConversation(db, id)).toMatchObject({
				status: 'idle',
				run_started_at: null,
				environment_id: null
			});
		}
	});

	it('finds duplicates by URL or server id, per user', () => {
		const a = repo.createCodingEnvironment(db, 'u1', {
			name: 'A',
			baseUrl: 'http://devbox.test/',
			token: 't',
			remoteEnvironmentId: 'env-1'
		});
		const find = (target: { baseUrl: string; remoteEnvironmentId?: string | null }, user = 'u1') =>
			repo.findDuplicateCodingEnvironment(db, user, target)?.id;
		expect(find({ baseUrl: 'http://DEVBOX.test' })).toBe(a.id);
		expect(find({ baseUrl: 'http://10.0.0.2', remoteEnvironmentId: 'env-1' })).toBe(a.id);
		expect(find({ baseUrl: 'http://10.0.0.2', remoteEnvironmentId: 'env-2' })).toBeUndefined();
		expect(find({ baseUrl: 'http://10.0.0.2', remoteEnvironmentId: null })).toBeUndefined();
		expect(find({ baseUrl: 'http://devbox.test' }, 'u2')).toBeUndefined();
		expect(
			repo.findDuplicateCodingEnvironment(db, 'u1', { baseUrl: 'http://devbox.test' }, a.id)
		).toBeUndefined();
	});

	it('records the server id on a check and clears it when the URL changes', () => {
		const row = repo.createCodingEnvironment(db, 'u1', {
			name: 'A',
			baseUrl: 'http://a.test',
			token: 't'
		});
		repo.recordEnvironmentCheck(db, row.id, { status: 'online', remoteEnvironmentId: 'env-1' });
		expect(repo.getCodingEnvironment(db, 'u1', row.id)?.remote_environment_id).toBe('env-1');
		repo.updateCodingEnvironment(db, 'u1', row.id, { name: 'Renamed' });
		expect(repo.getCodingEnvironment(db, 'u1', row.id)?.remote_environment_id).toBe('env-1');
		repo.updateCodingEnvironment(db, 'u1', row.id, { baseUrl: 'http://b.test' });
		expect(repo.getCodingEnvironment(db, 'u1', row.id)?.remote_environment_id).toBeNull();
	});

	it('flags the newer of two environments a check finds to be the same server', () => {
		const older = repo.createCodingEnvironment(db, 'u1', {
			name: 'Devbox',
			baseUrl: 'http://devbox.test',
			token: 't'
		});
		const newer = repo.createCodingEnvironment(db, 'u1', {
			name: 'Devbox (LAN)',
			baseUrl: 'http://10.0.0.2:3773',
			token: 't'
		});
		db.prepare('UPDATE coding_environments SET created_at = created_at + 1 WHERE id = ?').run(
			newer.id
		);
		// Another user's environment on the same server doesn't count.
		const foreign = repo.createCodingEnvironment(db, 'u2', {
			name: 'Theirs',
			baseUrl: 'http://devbox.test',
			token: 't'
		});
		const get = (id: string, user = 'u1') => repo.getCodingEnvironment(db, user, id)!;
		const expected = repo.duplicateEnvironmentError('Devbox');

		repo.recordEnvironmentCheck(db, older.id, { status: 'online', remoteEnvironmentId: 'env-1' });
		repo.recordEnvironmentCheck(db, foreign.id, { status: 'online', remoteEnvironmentId: 'env-1' });
		expect(get(older.id)).toMatchObject({ status: 'online', last_error: null });
		expect(get(foreign.id, 'u2')).toMatchObject({ status: 'online', last_error: null });

		// The newer one checked: it is the one flagged.
		repo.recordEnvironmentCheck(db, newer.id, { status: 'online', remoteEnvironmentId: 'env-1' });
		expect(get(newer.id)).toMatchObject({ status: 'error', last_error: expected });
		expect(get(older.id)).toMatchObject({ status: 'online', last_error: null });

		// The older one checked again later: still the newer one.
		repo.recordEnvironmentCheck(db, older.id, { status: 'online', remoteEnvironmentId: 'env-1' });
		expect(get(older.id).status).toBe('online');
		expect(get(newer.id)).toMatchObject({ status: 'error', last_error: expected });

		// Once the older one is gone, the newer one checks out fine.
		repo.deleteCodingEnvironment(db, 'u1', older.id);
		repo.recordEnvironmentCheck(db, newer.id, { status: 'online', remoteEnvironmentId: 'env-1' });
		expect(get(newer.id)).toMatchObject({ status: 'online', last_error: null });
	});
});
