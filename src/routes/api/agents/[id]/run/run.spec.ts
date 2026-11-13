import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';

vi.mock('$lib/server/agents/runner.js', () => ({
	startAgentRun: vi.fn()
}));

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createAgent } = await import('$lib/server/db/repo/agents.js');
const { createApiKey } = await import('$lib/server/db/repo/api-keys.js');
const { startAgentRun } = await import('$lib/server/agents/runner.js');
const { POST, _checkRateLimit, _rateBuckets } = await import('./+server.js');

type Db = ReturnType<typeof getDb>;
type AgentRunRow = import('$lib/server/db/repo/agent-runs.js').AgentRunRow;

const mockedStart = vi.mocked(startAgentRun);

interface CallInit {
	user?: { id: string; role?: string } | null;
	params?: Record<string, string>;
	body?: unknown;
	headers?: Record<string, string>;
}

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: CallInit = {}
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/agents/x/run');
	const headers = new Headers(init.headers);
	let body: string | undefined;
	if (init.body !== undefined) {
		headers.set('content-type', 'application/json');
		body = JSON.stringify(init.body);
	}
	const event = {
		locals: { user: init.user ?? null, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, { method: 'POST', headers, body }),
		url
	};
	try {
		const res = await handler(event as never);
		return { status: res.status, body: (await res.json()) as T };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body as T };
		throw e;
	}
}

const u1 = { id: 'u1', role: 'user' };
const u2 = { id: 'u2', role: 'user' };
const admin = { id: 'admin', role: 'admin' };

function seedUsers(db: Db) {
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
		 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user'),
		 ('admin', 'g@h.i', 'G', 0, 0, 0, 'admin')`
	).run();
}

function seedAgent(userId: string | null, enabled = true) {
	return createAgent(getDb(), userId, {
		name: 'a',
		systemPrompt: 'x',
		triggerType: 'http',
		enabled
	});
}

beforeEach(() => {
	closeDb();
	seedUsers(getDb());
	mockedStart.mockReset();
	mockedStart.mockImplementation(async ({ agentId, userId, trigger }) => {
		const run: AgentRunRow = {
			id: 'run-1',
			agent_id: agentId,
			user_id: userId,
			trigger,
			conversation_id: null,
			status: 'running',
			error: null,
			started_at: Date.now(),
			ended_at: null,
			api_key_id: null
		};
		return { run, done: Promise.resolve(run) };
	});
});

describe('POST /api/agents/[id]/run auth matrix', () => {
	it('returns 401 without any auth', async () => {
		const agent = seedAgent('u1');
		const res = await call(POST, { user: null, params: { id: agent.id } });
		expect(res.status).toBe(401);
		expect(mockedStart).not.toHaveBeenCalled();
	});

	it('returns 404 for an api key owned by another user', async () => {
		const agent = seedAgent('u1');
		const { rawKey } = await createApiKey(getDb(), { userId: 'u2', label: 'k' });
		const res = await call(POST, {
			user: null,
			params: { id: agent.id },
			headers: { authorization: `Bearer ${rawKey}` }
		});
		expect(res.status).toBe(404);
		expect(mockedStart).not.toHaveBeenCalled();
	});

	it('returns 403 for an api key without the agents:run scope', async () => {
		const agent = seedAgent('u1');
		const { rawKey } = await createApiKey(getDb(), { userId: 'u1', label: 'k', scopes: [] });
		const res = await call(POST, {
			user: null,
			params: { id: agent.id },
			headers: { authorization: `Bearer ${rawKey}` }
		});
		expect(res.status).toBe(403);
		expect(mockedStart).not.toHaveBeenCalled();
	});

	it('returns 404 for a session user that does not own the agent', async () => {
		const agent = seedAgent('u1');
		const res = await call(POST, { user: u2, params: { id: agent.id } });
		expect(res.status).toBe(404);
		expect(mockedStart).not.toHaveBeenCalled();
	});

	it('runs an owned agent via session as a manual trigger', async () => {
		const agent = seedAgent('u1');
		const res = await call<{ run: import('$lib/types.js').AgentRun }>(POST, {
			user: u1,
			params: { id: agent.id },
			body: { instructions: 'go' }
		});
		expect(res.status).toBe(202);
		expect(res.body.run.trigger).toBe('manual');
		expect(mockedStart).toHaveBeenCalledWith({
			agentId: agent.id,
			trigger: 'manual',
			userId: 'u1',
			instructions: 'go'
		});
	});

	it('runs an owned agent via api key as an http trigger', async () => {
		const agent = seedAgent('u1');
		const { row, rawKey } = await createApiKey(getDb(), { userId: 'u1', label: 'k' });
		const res = await call<{ run: import('$lib/types.js').AgentRun }>(POST, {
			user: null,
			params: { id: agent.id },
			headers: { authorization: `Bearer ${rawKey}` }
		});
		expect(res.status).toBe(202);
		expect(res.body.run.trigger).toBe('http');
		expect(mockedStart).toHaveBeenCalledWith({
			agentId: agent.id,
			trigger: 'http',
			userId: 'u1',
			instructions: undefined,
			apiKeyId: row.id
		});
	});

	it('ignores manual runs of enabled builtin agents for admins', async () => {
		const agent = seedAgent(null, true);
		const res = await call<{ ignored: boolean }>(POST, {
			user: admin,
			params: { id: agent.id }
		});
		expect(res.status).toBe(202);
		expect(res.body.ignored).toBe(true);
		expect(mockedStart).not.toHaveBeenCalled();
	});

	it('returns 403 when a non-admin runs a builtin agent', async () => {
		const agent = seedAgent(null, false);
		const res = await call(POST, { user: u1, params: { id: agent.id } });
		expect(res.status).toBe(403);
		expect(mockedStart).not.toHaveBeenCalled();
	});
});

describe('rate limit buckets', () => {
	it('limits per key and prunes expired buckets', () => {
		_rateBuckets.clear();
		const t0 = Date.now() + 120_000;
		for (let i = 0; i < 20; i++) expect(_checkRateLimit('a', t0)).toBe(true);
		expect(_checkRateLimit('a', t0)).toBe(false);
		_checkRateLimit('b', t0);
		expect(_rateBuckets.size).toBe(2);
		// After the window, a new key's access sweeps the stale buckets.
		expect(_checkRateLimit('c', t0 + 60_001)).toBe(true);
		expect([..._rateBuckets.keys()]).toEqual(['c']);
	});
});
