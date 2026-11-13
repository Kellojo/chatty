import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../index.js');
const servers = await import('./mcp-servers.js');
const usage = await import('./mcp-tool-usage.js');

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 13, 12);

describe('mcp-tool-usage repo', () => {
	let db: ReturnType<typeof openDatabase>;
	let serverId: string;

	beforeEach(() => {
		db = openDatabase(':memory:');
		const insertUser = db.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, \'user\')'
		);
		insertUser.run('u1', 'One', 'one@example.com');
		insertUser.run('u2', 'Two', 'two@example.com');
		serverId = servers.createMcpServer(db, {
			name: 'remote',
			transport: 'http',
			url: 'https://mcp.example.com'
		}).id;
	});

	const call = (toolName: string, userId: string, ok: boolean, durationMs: number, at: number) =>
		usage.recordMcpToolCall(db, { serverId, toolName, userId, ok, durationMs, at });

	it('aggregates calls per day, tool and user', () => {
		call('search', 'u1', true, 100, NOW);
		call('search', 'u1', false, 300, NOW - 1000);
		call('search', 'u2', true, 200, NOW - DAY);
		call('fetch', 'u1', true, 50, NOW);

		expect(usage.summarizeMcpUsage(db, NOW)[serverId]).toEqual({
			calls: 4,
			errors: 1,
			users: 2,
			lastUsedAt: NOW
		});

		const detail = usage.getMcpServerUsage(db, serverId, NOW);
		expect(detail.users).toBe(2);
		expect(detail.tools).toEqual([
			{ name: 'search', calls: 3, errors: 1, users: 2, avgMs: 200, lastUsedAt: NOW },
			{ name: 'fetch', calls: 1, errors: 0, users: 1, avgMs: 50, lastUsedAt: NOW }
		]);
		expect(detail.daily).toHaveLength(usage.MCP_USAGE_WINDOW_DAYS);
		expect(detail.daily.at(-1)).toEqual({ day: '2026-11-13', calls: 3, errors: 1 });
		expect(detail.daily.at(-2)).toEqual({ day: '2026-11-12', calls: 1, errors: 0 });
		expect(detail.daily[0].calls).toBe(0);
	});

	it('leaves calls before the window out of the counts but keeps the last use', () => {
		const old = NOW - 45 * DAY;
		call('search', 'u1', true, 10, old);

		expect(usage.summarizeMcpUsage(db, NOW)[serverId]).toEqual({
			calls: 0,
			errors: 0,
			users: 0,
			lastUsedAt: old
		});
		const detail = usage.getMcpServerUsage(db, serverId, NOW);
		expect(detail.tools).toEqual([]);
		expect(detail.daily.every((d) => d.calls === 0)).toBe(true);
	});

	it('splits stats per server and day over the chosen period', () => {
		const other = servers.createMcpServer(db, {
			name: 'other',
			transport: 'http',
			url: 'https://other.example.com'
		}).id;
		call('search', 'u1', true, 100, NOW);
		call('search', 'u1', false, 300, NOW);
		usage.recordMcpToolCall(db, {
			serverId: other,
			toolName: 'x',
			userId: 'u2',
			ok: true,
			durationMs: 20,
			at: NOW - 2 * DAY
		});
		call('search', 'u2', true, 10, NOW - 10 * DAY);

		const stats = usage.getMcpUsageStats(db, 7, NOW);
		expect(stats.days).toBe(7);
		expect(stats.users).toBe(2);
		expect(stats.servers).toEqual([
			{ serverId, calls: 2, errors: 1, users: 1, avgMs: 200, lastUsedAt: NOW },
			{ serverId: other, calls: 1, errors: 0, users: 1, avgMs: 20, lastUsedAt: NOW - 2 * DAY }
		]);
		expect(stats.daily).toHaveLength(7);
		expect(stats.daily.at(-1)).toEqual({
			day: '2026-11-13',
			calls: { [serverId]: 2 },
			errors: { [serverId]: 1 }
		});
		expect(stats.daily.at(-3)?.calls).toEqual({ [other]: 1 });
		expect(usage.getMcpUsageStats(db, 30, NOW).servers[0].calls).toBe(3);
	});

	it('is removed with its server', () => {
		call('search', 'u1', true, 10, NOW);
		servers.deleteMcpServer(db, serverId);
		expect(usage.summarizeMcpUsage(db, NOW)).toEqual({});
	});
});
