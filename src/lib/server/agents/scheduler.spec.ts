import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db/index.js';
import { createAgent, getAgent, setAgentOverride } from '../db/repo/agents.js';
import { createAgentRun } from '../db/repo/agent-runs.js';
import { createConversation } from '../db/repo/conversations.js';
import { computeNextRunAt, isValidCron, tickAgents } from './scheduler.js';

let db: Db;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
});

function seedScheduleAgent(nextRunAt: number = Date.now() - 1000) {
	return createAgent(db, 'u1', {
		name: 'sched',
		systemPrompt: 'x',
		triggerType: 'schedule',
		triggerConfig: { cron: '* * * * *' },
		nextRunAt
	});
}

describe('isValidCron', () => {
	it('accepts valid expressions and rejects invalid ones', () => {
		expect(isValidCron('*/5 * * * *')).toBe(true);
		expect(isValidCron('0 9 * * MON-FRI')).toBe(true);
		expect(isValidCron('not a cron')).toBe(false);
		expect(isValidCron('99 * * * *')).toBe(false);
	});
});

describe('computeNextRunAt', () => {
	it('returns a future timestamp respecting from', () => {
		const from = new Date('2026-01-01T12:00:00Z').getTime();
		const next = computeNextRunAt('0 * * * *', from);
		expect(next).toBe(new Date('2026-01-01T13:00:00Z').getTime());
		expect(computeNextRunAt('* * * * *')!).toBeGreaterThan(Date.now());
		expect(computeNextRunAt('invalid')).toBeNull();
	});
});

describe('tickAgents', () => {
	it('runs a due agent exactly once and reschedules into the future', async () => {
		const agent = seedScheduleAgent();
		const runAgentFn = vi.fn().mockResolvedValue(undefined);
		const started = await tickAgents(db, runAgentFn);
		expect(started).toBe(1);
		expect(runAgentFn).toHaveBeenCalledTimes(1);
		expect(runAgentFn).toHaveBeenCalledWith(agent.id, 'u1');
		const after = getAgent(db, agent.id)!;
		expect(after.next_run_at).not.toBeNull();
		expect(after.next_run_at!).toBeGreaterThan(Date.now());
		const again = await tickAgents(db, runAgentFn);
		expect(again).toBe(0);
		expect(runAgentFn).toHaveBeenCalledTimes(1);
	});

	it('skips non-due agents', async () => {
		seedScheduleAgent(Date.now() + 60_000);
		const runAgentFn = vi.fn().mockResolvedValue(undefined);
		expect(await tickAgents(db, runAgentFn)).toBe(0);
		expect(runAgentFn).not.toHaveBeenCalled();
	});

	it('reschedules even when the run throws', async () => {
		const agent = seedScheduleAgent();
		const runAgentFn = vi.fn().mockRejectedValue(new Error('boom'));
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const started = await tickAgents(db, runAgentFn);
		expect(started).toBe(1);
		const after = getAgent(db, agent.id)!;
		expect(after.next_run_at!).toBeGreaterThan(Date.now());
		consoleError.mockRestore();
	});

	it('skips a due agent that already has a running run', async () => {
		const agent = seedScheduleAgent();
		createAgentRun(db, { agentId: agent.id, userId: 'u1', trigger: 'schedule' });
		const runAgentFn = vi.fn().mockResolvedValue(undefined);
		expect(await tickAgents(db, runAgentFn)).toBe(0);
		expect(runAgentFn).not.toHaveBeenCalled();
	});

	it('fans out a built-in (user_id NULL) schedule agent once per active user', async () => {
		db.prepare(
			'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
		).run();
		createConversation(db, 'u1', { title: 'a' });
		createConversation(db, 'u2', { title: 'b' });
		const agent = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: '* * * * *' },
			nextRunAt: Date.now() - 1000
		});
		const runAgentFn = vi.fn().mockResolvedValue(undefined);
		const started = await tickAgents(db, runAgentFn);
		expect(started).toBe(1);
		expect(runAgentFn).toHaveBeenCalledTimes(2);
		expect(runAgentFn).toHaveBeenCalledWith(agent.id, 'u1');
		expect(runAgentFn).toHaveBeenCalledWith(agent.id, 'u2');
	});

	it('skips users whose override disables a built-in agent', async () => {
		db.prepare(
			'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
		).run();
		createConversation(db, 'u1', { title: 'a' });
		createConversation(db, 'u2', { title: 'b' });
		const agent = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: '* * * * *' },
			nextRunAt: Date.now() - 1000
		});
		setAgentOverride(db, 'u2', agent.id, false);
		const runAgentFn = vi.fn().mockResolvedValue(undefined);
		const started = await tickAgents(db, runAgentFn);
		expect(started).toBe(1);
		expect(runAgentFn).toHaveBeenCalledTimes(1);
		expect(runAgentFn).toHaveBeenCalledWith(agent.id, 'u1');
	});

	it('fans out a row-disabled built-in only to users with an enabling override', async () => {
		db.prepare(
			'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
		).run();
		createConversation(db, 'u1', { title: 'a' });
		createConversation(db, 'u2', { title: 'b' });
		const agent = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: '* * * * *' },
			enabled: false,
			nextRunAt: Date.now() - 1000
		});
		setAgentOverride(db, 'u2', agent.id, true);
		const runAgentFn = vi.fn().mockResolvedValue(undefined);
		const started = await tickAgents(db, runAgentFn);
		expect(started).toBe(1);
		expect(runAgentFn).toHaveBeenCalledTimes(1);
		expect(runAgentFn).toHaveBeenCalledWith(agent.id, 'u2');
	});

	it('counts a built-in agent as started even with no active users', async () => {
		const agent = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: '* * * * *' },
			nextRunAt: Date.now() - 1000
		});
		const runAgentFn = vi.fn().mockResolvedValue(undefined);
		expect(await tickAgents(db, runAgentFn)).toBe(1);
		expect(runAgentFn).not.toHaveBeenCalled();
		expect(getAgent(db, agent.id)!.next_run_at!).toBeGreaterThan(Date.now());
	});

	it('does not start a second run while one is in flight', async () => {
		seedScheduleAgent();
		let release!: () => void;
		const runAgentFn = vi
			.fn()
			.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
		const first = tickAgents(db, runAgentFn);
		await new Promise((r) => setTimeout(r, 10));
		expect(await tickAgents(db, runAgentFn)).toBe(0);
		release();
		expect(await first).toBe(1);
		expect(runAgentFn).toHaveBeenCalledTimes(1);
	});
});

describe('tickAgents concurrency', () => {
	it('starts every due agent without waiting for earlier runs to finish', async () => {
		const a = seedScheduleAgent();
		const b = seedScheduleAgent();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const runAgentFn = vi.fn().mockReturnValue(gate);
		const tick = tickAgents(db, runAgentFn);
		await vi.waitFor(() => expect(runAgentFn).toHaveBeenCalledTimes(2));
		expect(runAgentFn.mock.calls.map((c) => c[0]).sort()).toEqual([a.id, b.id].sort());
		release();
		expect(await tick).toBe(2);
	});
});
