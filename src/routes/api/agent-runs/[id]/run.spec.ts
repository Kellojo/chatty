import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createAgentRun } = await import('$lib/server/db/repo/agent-runs.js');
const { createAgent } = await import('$lib/server/db/repo/agents.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');
const { createMessage } = await import('$lib/server/db/repo/messages.js');
const { GET } = await import('./+server.js');

interface Body {
	run: { id: string };
	messages: { id: string; status: string }[];
	from: string | null;
}

async function call(
	user: { id: string; role?: string } | null,
	runId: string,
	query = ''
): Promise<{ status: number; body: Body }> {
	const url = new URL(`http://localhost/api/agent-runs/${runId}${query}`);
	const event = {
		locals: { user, session: null } as unknown as App.Locals,
		params: { id: runId },
		request: new Request(url),
		url
	};
	try {
		const res = await GET(event as never);
		return { status: res.status, body: (await res.json()) as Body };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body as never };
		throw e;
	}
}

const u1 = { id: 'u1', role: 'user' };
const u2 = { id: 'u2', role: 'user' };
const admin = { id: 'u2', role: 'admin' };

function seedRun() {
	const db = getDb();
	const agent = createAgent(db, 'u1', { name: 'a', systemPrompt: 'x', triggerType: 'manual' });
	const conversationId = createConversation(db, 'u1', { kind: 'agent-run' }).id;
	const run = createAgentRun(db, {
		agentId: agent.id,
		userId: 'u1',
		trigger: 'manual',
		conversationId
	});
	const ids = [
		createMessage(db, { conversationId, role: 'user', parts: [], createdAt: 1 }).id,
		createMessage(db, { conversationId, role: 'assistant', parts: [], createdAt: 2 }).id,
		createMessage(db, {
			conversationId,
			role: 'assistant',
			parts: [],
			status: 'partial',
			createdAt: 3
		}).id
	];
	return { run, ids };
}

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
			 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
			 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
		)
		.run();
});

describe('GET /api/agent-runs/[id]', () => {
	it('returns 404 for another user and lets admins read', async () => {
		const { run, ids } = seedRun();
		expect((await call(u2, run.id)).status).toBe(404);
		expect((await call(u2, run.id, `?from=${ids[0]}`)).status).toBe(404);
		expect((await call(admin, run.id)).status).toBe(200);
	});

	it('returns the full transcript without a cursor', async () => {
		const { run, ids } = seedRun();
		const res = await call(u1, run.id);
		expect(res.status).toBe(200);
		expect(res.body.from).toBeNull();
		expect(res.body.messages.map((m) => m.id)).toEqual(ids);
	});

	it('returns only the tail from the cursor', async () => {
		const { run, ids } = seedRun();
		const res = await call(u1, run.id, `?from=${ids[1]}`);
		expect(res.body.from).toBe(ids[1]);
		expect(res.body.messages.map((m) => m.id)).toEqual(ids.slice(1));
	});

	it('falls back to the full transcript for an unknown cursor', async () => {
		const { run, ids } = seedRun();
		const res = await call(u1, run.id, '?from=missing');
		expect(res.body.from).toBeNull();
		expect(res.body.messages.map((m) => m.id)).toEqual(ids);
	});
});
