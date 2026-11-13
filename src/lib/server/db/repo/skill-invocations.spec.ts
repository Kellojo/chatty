import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInvocationTrigger } from './skill-invocations.js';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../index.js');
const repo = await import('./skill-invocations.js');

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 13, 12);
const ADMIN = { userId: 'u1', isAdmin: true };
const MEMBER = { userId: 'u2', isAdmin: false };

describe('skill usage', () => {
	let db: ReturnType<typeof openDatabase>;

	beforeEach(() => {
		db = openDatabase(':memory:');
	});

	const use = (
		skillName: string,
		scope: 'user' | 'shared',
		userId: string,
		triggeredBy: SkillInvocationTrigger,
		at: number
	) => repo.recordSkillInvocation(db, { skillName, scope, userId, triggeredBy, at });

	it('summarizes uses in the window and the last use beyond it', () => {
		use('pdf', 'shared', 'u1', 'auto', NOW);
		use('pdf', 'shared', 'u2', 'manual', NOW - DAY);
		use('pdf', 'shared', 'u2', 'auto', NOW - 40 * DAY);
		use('old', 'user', 'u1', 'auto', NOW - 40 * DAY);

		const summary = repo.summarizeSkillUsage(db, ADMIN, NOW);
		expect(summary['shared:pdf']).toEqual({ uses: 2, users: 2, lastUsedAt: NOW });
		expect(summary['user:old']).toEqual({ uses: 0, users: 0, lastUsedAt: NOW - 40 * DAY });
	});

	it('shows members only their own uses, and nobody else’s private skills', () => {
		use('pdf', 'shared', 'u1', 'auto', NOW);
		use('pdf', 'shared', 'u2', 'auto', NOW);
		use('mine', 'user', 'u1', 'auto', NOW);
		use('mine', 'user', 'u2', 'manual', NOW);

		expect(repo.summarizeSkillUsage(db, MEMBER, NOW)).toEqual({
			'shared:pdf': { uses: 1, users: 1, lastUsedAt: NOW },
			'user:mine': { uses: 1, users: 1, lastUsedAt: NOW }
		});
		// An admin sees everyone's uses of shared skills, but only their own private ones.
		const admin = repo.summarizeSkillUsage(db, ADMIN, NOW);
		expect(admin['shared:pdf'].uses).toBe(2);
		expect(admin['user:mine'].uses).toBe(1);
	});

	it('splits stats by skill, trigger and day', () => {
		use('pdf', 'shared', 'u1', 'auto', NOW);
		use('pdf', 'shared', 'u1', 'agent', NOW);
		use('pdf', 'shared', 'u2', 'manual', NOW - DAY);
		use('notes', 'user', 'u1', 'manual', NOW - 2 * DAY);
		use('notes', 'user', 'u1', 'manual', NOW - 10 * DAY);

		const stats = repo.getSkillUsageStats(db, ADMIN, 7, NOW);
		expect(stats.days).toBe(7);
		expect(stats.users).toBe(2);
		expect(stats.skills).toEqual([
			{
				key: 'shared:pdf',
				scope: 'shared',
				name: 'pdf',
				uses: 3,
				users: 2,
				manual: 1,
				auto: 1,
				agent: 1,
				lastUsedAt: NOW
			},
			{
				key: 'user:notes',
				scope: 'user',
				name: 'notes',
				uses: 1,
				users: 1,
				manual: 1,
				auto: 0,
				agent: 0,
				lastUsedAt: NOW - 2 * DAY
			}
		]);
		expect(stats.daily).toHaveLength(7);
		expect(stats.daily[6]).toEqual({ day: '2026-11-13', uses: { 'shared:pdf': 2 } });
		expect(stats.daily[5].uses).toEqual({ 'shared:pdf': 1 });
		expect(stats.daily[4].uses).toEqual({ 'user:notes': 1 });
	});

	it('details one skill per trigger and day', () => {
		use('pdf', 'shared', 'u1', 'auto', NOW);
		use('pdf', 'shared', 'u2', 'auto', NOW - DAY);
		use('pdf', 'shared', 'u2', 'agent', NOW - DAY);
		use('pdf', 'user', 'u1', 'manual', NOW);

		const detail = repo.getSkillUsage(db, ADMIN, { scope: 'shared', name: 'pdf' }, NOW);
		expect(detail.days).toBe(30);
		expect(detail.users).toBe(2);
		expect(detail.uses).toEqual({ manual: 0, auto: 2, agent: 1 });
		expect(detail.daily).toHaveLength(30);
		expect(detail.daily.at(-1)).toEqual({ day: '2026-11-13', manual: 0, auto: 1, agent: 0 });
		expect(detail.daily.at(-2)).toEqual({ day: '2026-11-12', manual: 0, auto: 1, agent: 1 });

		const own = repo.getSkillUsage(db, MEMBER, { scope: 'shared', name: 'pdf' }, NOW);
		expect(own.uses).toEqual({ manual: 0, auto: 1, agent: 1 });
	});
});
