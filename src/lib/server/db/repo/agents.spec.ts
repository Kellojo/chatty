import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import { createAgentRun, finishAgentRun } from './agent-runs.js';
import {
	claimAgentRun,
	createAgent,
	deleteAgent,
	effectiveEnabled,
	getAgent,
	listAgentOverrides,
	listAgents,
	listDueScheduleAgents,
	listOverridesForAgent,
	listPersonaAgents,
	listUsersWithActivitySinceLastRun,
	setAgentOverride,
	setAgentRunTimes,
	toPublic,
	toPublicWithOverrides,
	updateAgent
} from './agents.js';
import { createConversation, softDeleteConversation } from './conversations.js';

let db: Db;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
});

describe('agents repo', () => {
	it('creates and reads an agent with JSON fields', () => {
		const row = createAgent(db, 'u1', {
			name: 'researcher',
			description: 'digs',
			systemPrompt: 'You research.',
			skillNames: ['web'],
			toolAllowlist: ['webfetch'],
			triggerType: 'schedule',
			triggerConfig: { cron: '*/5 * * * *' },
			maxSteps: 7
		});
		expect(row.id).toBeTruthy();
		const fetched = getAgent(db, row.id)!;
		const pub = toPublic(fetched);
		expect(pub.name).toBe('researcher');
		expect(pub.skillNames).toEqual(['web']);
		expect(pub.toolAllowlist).toEqual(['webfetch']);
		expect(pub.triggerConfig).toEqual({ cron: '*/5 * * * *' });
		expect(pub.maxSteps).toBe(7);
		expect(pub.enabled).toBe(true);
		expect(getAgent(db, 'missing')).toBeUndefined();
	});

	it('listAgents returns own and builtin agents', () => {
		const own = createAgent(db, 'u1', { name: 'own', systemPrompt: 'x', triggerType: 'manual' });
		const builtin = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		db.prepare(
			'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
		).run();
		createAgent(db, 'u2', { name: 'other', systemPrompt: 'x', triggerType: 'manual' });
		expect(listAgents(db, 'u1').map((a) => a.id)).toEqual([own.id, builtin.id]);
	});

	it('listPersonaAgents filters to enabled persona agents', () => {
		const persona = createAgent(db, 'u1', {
			name: 'persona',
			systemPrompt: 'x',
			triggerType: 'persona'
		});
		createAgent(db, 'u1', { name: 'sched', systemPrompt: 'x', triggerType: 'schedule' });
		createAgent(db, 'u1', {
			name: 'off',
			systemPrompt: 'x',
			triggerType: 'persona',
			enabled: false
		});
		expect(listPersonaAgents(db, 'u1').map((a) => a.id)).toEqual([persona.id]);
	});

	it('listDueScheduleAgents returns due, enabled schedule agents including built-ins', () => {
		const past = Date.now() - 1000;
		const due = createAgent(db, 'u1', {
			name: 'due',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: '* * * * *' },
			nextRunAt: past
		});
		createAgent(db, 'u1', {
			name: 'future',
			systemPrompt: 'x',
			triggerType: 'schedule',
			nextRunAt: Date.now() + 60_000
		});
		createAgent(db, 'u1', {
			name: 'disabled',
			systemPrompt: 'x',
			triggerType: 'schedule',
			nextRunAt: past,
			enabled: false
		});
		const builtin = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'schedule',
			nextRunAt: past
		});
		createAgent(db, 'u1', { name: 'manual', systemPrompt: 'x', triggerType: 'manual' });
		expect(listDueScheduleAgents(db, Date.now()).map((a) => a.id)).toEqual([due.id, builtin.id]);
	});

	it('listUsersWithActivitySinceLastRun tracks each user against their own last run', () => {
		for (const id of ['u2', 'u3', 'u4']) {
			db.prepare(
				`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (?, ?, ?, 0, 0, 0, 'user')`
			).run(id, `${id}@x.y`, id);
		}
		const agent = createAgent(db, null, {
			name: 'mem',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: '* * * * *' }
		});
		const setUpdated = (id: string, at: number) =>
			db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at, id);
		const endRun = (userId: string, at: number) => {
			const run = createAgentRun(db, { agentId: agent.id, userId, trigger: 'schedule' });
			db.prepare("UPDATE agent_runs SET status = 'success', ended_at = ? WHERE id = ?").run(
				at,
				run.id
			);
		};
		// u1 never ran: any activity counts.
		setUpdated(createConversation(db, 'u1', { title: 'a' }).id, 100);
		// u2's last run ended after its activity; another user's later run doesn't matter.
		setUpdated(createConversation(db, 'u2', { title: 'b' }).id, 500);
		endRun('u2', 600);
		endRun('u1', 50);
		// u3 was active after its last run, even though u2 ran later.
		setUpdated(createConversation(db, 'u3', { title: 'c' }).id, 400);
		endRun('u3', 300);
		// u4's only newer conversation is the agent's own run transcript.
		const transcript = createConversation(db, 'u4', {
			title: 'run',
			kind: 'agent-run',
			agentId: agent.id
		});
		setUpdated(transcript.id, 900);
		endRun('u4', 800);
		softDeleteConversation(db, 'u4', createConversation(db, 'u4', { title: 'd' }).id);

		expect(listUsersWithActivitySinceLastRun(db, agent.id)).toEqual(['u1', 'u3']);
	});

	it("listUsersWithActivitySinceLastRun ignores chats dispatched for any agent's runs", () => {
		const agent = createAgent(db, null, {
			name: 'mem',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: '* * * * *' }
		});
		const other = createAgent(db, 'u1', {
			name: 'inbox',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		createConversation(db, 'u1', { title: 'run', origin: 'dispatch', agentId: other.id });
		expect(listUsersWithActivitySinceLastRun(db, agent.id)).toEqual([]);
		createConversation(db, 'u1', { title: 'mine' });
		expect(listUsersWithActivitySinceLastRun(db, agent.id)).toEqual(['u1']);
	});

	it('defaults new user agents to asking and built-ins to never', () => {
		const mine = createAgent(db, 'u1', { name: 'a', systemPrompt: 'x', triggerType: 'manual' });
		const builtin = createAgent(db, null, { name: 'b', systemPrompt: 'x', triggerType: 'manual' });
		expect(toPublic(mine).canAsk).toBe('any');
		expect(toPublic(builtin).canAsk).toBe('never');
		expect(toPublic(updateAgent(db, mine.id, { canAsk: 'approvals' })!).canAsk).toBe('approvals');
	});

	it('listDueScheduleAgents excludes agents with a running run', () => {
		const past = Date.now() - 1000;
		const agent = createAgent(db, 'u1', {
			name: 'due',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: '* * * * *' },
			nextRunAt: past
		});
		const run = createAgentRun(db, { agentId: agent.id, userId: 'u1', trigger: 'schedule' });
		expect(listDueScheduleAgents(db, Date.now()).map((a) => a.id)).toEqual([]);
		finishAgentRun(db, run.id, 'success');
		expect(listDueScheduleAgents(db, Date.now()).map((a) => a.id)).toEqual([agent.id]);
	});

	it('updateAgent patches fields and bumps updated_at', () => {
		const row = createAgent(db, 'u1', {
			name: 'a',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		const updated = updateAgent(db, row.id, {
			name: 'b',
			enabled: false,
			maxSteps: 3,
			toolAllowlist: null
		})!;
		expect(updated.name).toBe('b');
		expect(updated.enabled).toBe(0);
		expect(updated.max_steps).toBe(3);
		expect(updated.tool_allowlist).toBeNull();
		expect(updated.updated_at).toBeGreaterThanOrEqual(row.updated_at);
		expect(updateAgent(db, 'missing', { name: 'x' })).toBeUndefined();
	});

	it('setAgentRunTimes sets only the given fields', () => {
		const row = createAgent(db, 'u1', {
			name: 'a',
			systemPrompt: 'x',
			triggerType: 'schedule',
			nextRunAt: 111
		});
		setAgentRunTimes(db, row.id, { lastRunAt: 222 });
		let fetched = getAgent(db, row.id)!;
		expect(fetched.last_run_at).toBe(222);
		expect(fetched.next_run_at).toBe(111);
		setAgentRunTimes(db, row.id, { nextRunAt: 333 });
		fetched = getAgent(db, row.id)!;
		expect(fetched.last_run_at).toBe(222);
		expect(fetched.next_run_at).toBe(333);
	});

	it('claimAgentRun succeeds once for a stale expected value', () => {
		const row = createAgent(db, 'u1', {
			name: 'a',
			systemPrompt: 'x',
			triggerType: 'schedule',
			nextRunAt: 111
		});
		expect(claimAgentRun(db, row.id, 111, 222)).toBe(true);
		expect(getAgent(db, row.id)!.next_run_at).toBe(222);
		expect(claimAgentRun(db, row.id, 111, 333)).toBe(false);
		expect(claimAgentRun(db, row.id, 222, null)).toBe(true);
		expect(getAgent(db, row.id)!.next_run_at).toBeNull();
		expect(claimAgentRun(db, row.id, 222, 333)).toBe(false);
		expect(claimAgentRun(db, row.id, null, 333)).toBe(true);
	});

	it('setAgentOverride inserts and upserts a per-user override', () => {
		const builtin = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		setAgentOverride(db, 'u1', builtin.id, false);
		expect(listAgentOverrides(db, 'u1').get(builtin.id)).toBe(false);
		setAgentOverride(db, 'u1', builtin.id, true);
		const overrides = listAgentOverrides(db, 'u1');
		expect(overrides.size).toBe(1);
		expect(overrides.get(builtin.id)).toBe(true);
		expect(listAgentOverrides(db, 'nobody').size).toBe(0);
	});

	it('listOverridesForAgent returns a per-user map for one agent', () => {
		db.prepare(
			'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
		).run();
		const builtin = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		const other = createAgent(db, null, {
			name: 'other',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		setAgentOverride(db, 'u1', builtin.id, false);
		setAgentOverride(db, 'u2', builtin.id, true);
		setAgentOverride(db, 'u1', other.id, false);
		const overrides = listOverridesForAgent(db, builtin.id);
		expect(overrides.size).toBe(2);
		expect(overrides.get('u1')).toBe(false);
		expect(overrides.get('u2')).toBe(true);
	});

	it('effectiveEnabled applies overrides only to built-in agents', () => {
		const builtin = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		const disabledBuiltin = createAgent(db, null, {
			name: 'off',
			systemPrompt: 'x',
			triggerType: 'manual',
			enabled: false
		});
		const own = createAgent(db, 'u1', { name: 'own', systemPrompt: 'x', triggerType: 'manual' });
		expect(effectiveEnabled(builtin, new Map())).toBe(true);
		expect(effectiveEnabled(builtin, new Map([[builtin.id, false]]))).toBe(false);
		expect(effectiveEnabled(disabledBuiltin, new Map())).toBe(false);
		expect(effectiveEnabled(disabledBuiltin, new Map([[disabledBuiltin.id, true]]))).toBe(true);
		expect(effectiveEnabled(own, new Map([[own.id, false]]))).toBe(true);
	});

	it('toPublicWithOverrides reflects the effective enabled state', () => {
		const builtin = createAgent(db, null, {
			name: 'builtin',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		const overrides = new Map([[builtin.id, false]]);
		expect(toPublicWithOverrides(builtin, overrides).enabled).toBe(false);
		expect(toPublic(builtin).enabled).toBe(true);
	});

	it('deleteAgent removes the row', () => {
		const row = createAgent(db, 'u1', { name: 'a', systemPrompt: 'x', triggerType: 'manual' });
		expect(deleteAgent(db, row.id)).toBe(true);
		expect(deleteAgent(db, row.id)).toBe(false);
	});
});
