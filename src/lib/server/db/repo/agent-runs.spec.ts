import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import {
	createAgentRun,
	failRunningAgentRuns,
	finishAgentRun,
	getAgentRun,
	getAgentRunByConversation,
	hasRunningAgentRun,
	lastSuccessfulAgentRunStartedAt,
	listAgentRuns,
	listLatestAgentRuns,
	listRunningAgentIds,
	toPublic
} from './agent-runs.js';
import { createAgent } from './agents.js';
import { createConversation } from './conversations.js';

let db: Db;
let agentId: string;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
	agentId = createAgent(db, 'u1', { name: 'a', systemPrompt: 'x', triggerType: 'manual' }).id;
});

describe('agent-runs repo', () => {
	it('creates a running run and finishes it', () => {
		const run = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		expect(run.status).toBe('running');
		expect(run.started_at).toBeGreaterThan(0);
		expect(run.ended_at).toBeNull();
		finishAgentRun(db, run.id, 'success');
		const done = getAgentRun(db, run.id)!;
		expect(done.status).toBe('success');
		expect(done.ended_at).not.toBeNull();
		const pub = toPublic(done);
		expect(pub.agentId).toBe(agentId);
		expect(pub.status).toBe('success');
	});

	it('hasRunningAgentRun and lastSuccessfulAgentRunStartedAt are per agent and user', () => {
		expect(lastSuccessfulAgentRunStartedAt(db, agentId, 'u1')).toBeNull();
		const first = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		expect(hasRunningAgentRun(db, agentId, 'u1')).toBe(true);
		expect(hasRunningAgentRun(db, agentId, 'u2')).toBe(false);
		db.prepare(
			"UPDATE agent_runs SET status = 'success', started_at = 100, ended_at = 123 WHERE id = ?"
		).run(first.id);
		expect(hasRunningAgentRun(db, agentId, 'u1')).toBe(false);
		// Running and failed runs don't move the window.
		createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		const failed = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		finishAgentRun(db, failed.id, 'failed', 'boom');
		expect(lastSuccessfulAgentRunStartedAt(db, agentId, 'u1')).toBe(100);
		expect(lastSuccessfulAgentRunStartedAt(db, agentId, 'u2')).toBeNull();
	});

	it('finishAgentRun persists errors', () => {
		const run = createAgentRun(db, { agentId, userId: 'u1', trigger: 'schedule' });
		finishAgentRun(db, run.id, 'failed', 'boom');
		const done = getAgentRun(db, run.id)!;
		expect(done.status).toBe('failed');
		expect(done.error).toBe('boom');
	});

	it('listAgentRuns orders by started_at DESC and honors limit', async () => {
		const first = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		await new Promise((r) => setTimeout(r, 5));
		const second = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		const list = listAgentRuns(db, agentId);
		expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
		expect(listAgentRuns(db, agentId, 1).map((r) => r.id)).toEqual([second.id]);
	});

	it('listAgentRuns filters by userId when given', () => {
		db.prepare(
			'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
		).run();
		const mine = createAgentRun(db, { agentId, userId: 'u1', trigger: 'event' });
		createAgentRun(db, { agentId, userId: 'u2', trigger: 'event' });
		expect(listAgentRuns(db, agentId)).toHaveLength(2);
		expect(listAgentRuns(db, agentId, 50, 'u1').map((r) => r.id)).toEqual([mine.id]);
		expect(listAgentRuns(db, agentId, 50, 'u2')).toHaveLength(1);
	});

	it('listRunningAgentIds returns [] for empty input', () => {
		createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		expect(listRunningAgentIds(db, [])).toEqual([]);
	});

	it('listRunningAgentIds returns [] when nothing is running', () => {
		const run = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		finishAgentRun(db, run.id, 'success');
		expect(listRunningAgentIds(db, [agentId])).toEqual([]);
	});

	it('listRunningAgentIds returns only agents with a running run', () => {
		const other = createAgent(db, 'u1', { name: 'b', systemPrompt: 'x', triggerType: 'manual' }).id;
		createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		const done = createAgentRun(db, { agentId: other, userId: 'u1', trigger: 'manual' });
		finishAgentRun(db, done.id, 'failed');
		expect(listRunningAgentIds(db, [agentId, other])).toEqual([agentId]);
	});

	it('listRunningAgentIds excludes ids outside the input list', () => {
		const other = createAgent(db, 'u1', { name: 'b', systemPrompt: 'x', triggerType: 'manual' }).id;
		createAgentRun(db, { agentId: other, userId: 'u1', trigger: 'manual' });
		expect(listRunningAgentIds(db, [agentId])).toEqual([]);
	});

	it('listRunningAgentIds dedupes multiple running runs for one agent', () => {
		createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		createAgentRun(db, { agentId, userId: 'u1', trigger: 'schedule' });
		expect(listRunningAgentIds(db, [agentId])).toEqual([agentId]);
	});

	it('listLatestAgentRuns returns the newest run per agent for the user', () => {
		db.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
		).run();
		const other = createAgent(db, 'u1', { name: 'b', systemPrompt: 'x', triggerType: 'manual' }).id;
		const idle = createAgent(db, 'u1', { name: 'c', systemPrompt: 'x', triggerType: 'manual' }).id;
		const old = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		const newest = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		db.prepare('UPDATE agent_runs SET started_at = 100 WHERE id = ?').run(old.id);
		db.prepare('UPDATE agent_runs SET started_at = 200 WHERE id = ?').run(newest.id);
		const theirs = createAgentRun(db, { agentId, userId: 'u2', trigger: 'manual' });
		db.prepare('UPDATE agent_runs SET started_at = 300 WHERE id = ?').run(theirs.id);
		const otherRun = createAgentRun(db, { agentId: other, userId: 'u1', trigger: 'manual' });
		const latest = listLatestAgentRuns(db, [agentId, other, idle], 'u1');
		expect(latest.map((r) => r.id).sort()).toEqual([newest.id, otherRun.id].sort());
		expect(listLatestAgentRuns(db, [], 'u1')).toEqual([]);
	});

	it('failRunningAgentRuns marks only running rows', () => {
		const running = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		const done = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		finishAgentRun(db, done.id, 'success');
		expect(failRunningAgentRuns(db)).toBe(1);
		const row = getAgentRun(db, running.id)!;
		expect(row.status).toBe('failed');
		expect(row.error).toBe('Interrupted by server restart');
		expect(row.ended_at).not.toBeNull();
		expect(failRunningAgentRuns(db)).toBe(0);
	});

	it('getAgentRunByConversation finds the run that owns a conversation', () => {
		const conversationId = createConversation(db, 'u1', { kind: 'agent-run' }).id;
		createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		const run = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual', conversationId });
		expect(getAgentRunByConversation(db, conversationId)?.id).toBe(run.id);
		expect(getAgentRunByConversation(db, 'missing')).toBeUndefined();
	});
});
