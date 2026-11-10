import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

vi.mock('$lib/server/agents/runner.js', () => ({
	stopAgentRun: vi.fn()
}));

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createAgentRun, finishAgentRun } = await import('$lib/server/db/repo/agent-runs.js');
const { createAgent } = await import('$lib/server/db/repo/agents.js');
const { stopAgentRun } = await import('$lib/server/agents/runner.js');
const { POST } = await import('./+server.js');

type Db = ReturnType<typeof getDb>;

const mockedStop = vi.mocked(stopAgentRun);

interface CallInit {
	user?: { id: string; role?: string } | null;
	params?: Record<string, string>;
}

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: CallInit = {}
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/agent-runs/x/stop');
	const event = {
		locals: { user: init.user ?? null, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, { method: 'POST' }),
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

function seedUsers(db: Db) {
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
		 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
	).run();
}

function seedRun(userId: string) {
	const agent = createAgent(getDb(), userId, {
		name: 'a',
		systemPrompt: 'x',
		triggerType: 'manual'
	});
	return createAgentRun(getDb(), { agentId: agent.id, userId, trigger: 'manual' });
}

beforeEach(() => {
	closeDb();
	seedUsers(getDb());
	mockedStop.mockReset();
});

describe('POST /api/agent-runs/[id]/stop', () => {
	it('returns 401 without auth', async () => {
		const run = seedRun('u1');
		const res = await call(POST, { user: null, params: { id: run.id } });
		expect(res.status).toBe(401);
		expect(mockedStop).not.toHaveBeenCalled();
	});

	it("returns 404 for another user's run", async () => {
		const run = seedRun('u1');
		const res = await call(POST, { user: u2, params: { id: run.id } });
		expect(res.status).toBe(404);
		expect(mockedStop).not.toHaveBeenCalled();
	});

	it('returns 409 when the run is not running', async () => {
		const run = seedRun('u1');
		finishAgentRun(getDb(), run.id, 'success');
		const res = await call(POST, { user: u1, params: { id: run.id } });
		expect(res.status).toBe(409);
		expect(res.body).toEqual({ message: 'Run is not running' });
		expect(mockedStop).not.toHaveBeenCalled();
	});

	it('returns 409 when the run is not active on this server', async () => {
		mockedStop.mockReturnValue(false);
		const run = seedRun('u1');
		const res = await call(POST, { user: u1, params: { id: run.id } });
		expect(res.status).toBe(409);
		expect(res.body).toEqual({ message: 'Run is not active on this server' });
		expect(mockedStop).toHaveBeenCalledWith(run.id, expect.anything());
	});

	it('returns ok when the run is stopped', async () => {
		mockedStop.mockReturnValue(true);
		const run = seedRun('u1');
		const res = await call<{ ok: boolean }>(POST, { user: u1, params: { id: run.id } });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		expect(mockedStop).toHaveBeenCalledWith(run.id, expect.anything());
	});
});
