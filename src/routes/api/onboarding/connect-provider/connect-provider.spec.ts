import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const fetchModelsForProvider = vi.fn();
vi.mock('$lib/server/llm/registry.js', () => ({ fetchModelsForProvider }));
vi.mock('$lib/server/benchmarks/artificial-analysis.js', () => ({
	refreshScores: vi.fn(async () => undefined)
}));

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { findRoleModel } = await import('$lib/server/db/repo/models.js');
const { listProviders } = await import('$lib/server/db/repo/providers.js');
const { POST } = await import('./+server.js');

const admin = { id: 'a1', role: 'admin' };

async function connect(body: unknown, user: { id: string; role: string } | null = admin) {
	const url = new URL('http://localhost/api/onboarding/connect-provider');
	const event = {
		locals: { user, session: null } as unknown as App.Locals,
		params: {},
		request: new Request(url, { method: 'POST', body: JSON.stringify(body) }),
		url
	};
	try {
		const res = await POST(event as never);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	} catch (e) {
		if (isHttpError(e))
			return { status: e.status, body: e.body as unknown as Record<string, unknown> };
		throw e;
	}
}

const anthropic = { name: 'Anthropic', type: 'anthropic', apiKey: 'sk-test' };

beforeEach(() => {
	closeDb();
	fetchModelsForProvider.mockReset();
});

describe('POST /api/onboarding/connect-provider', () => {
	it('is admin-only', async () => {
		const res = await connect(anthropic, { id: 'u1', role: 'user' });
		expect(res.status).toBe(403);
	});

	it('saves the provider, its models and a default chat model', async () => {
		fetchModelsForProvider.mockResolvedValue([
			{ id: 'claude-new', capabilities: ['chat', 'tool_use', 'vision'] },
			{ id: 'claude-old', capabilities: ['chat'] }
		]);
		const res = await connect(anthropic);
		expect(res.status).toBe(201);
		expect(listProviders(getDb())).toHaveLength(1);
		expect(findRoleModel(getDb(), 'chat')?.model_id).toBe('claude-new');
		expect(res.body.chatModelId).toBe(findRoleModel(getDb(), 'chat')?.id);
	});

	it('writes nothing when the provider rejects the key', async () => {
		fetchModelsForProvider.mockRejectedValue(new Error('Anthropic /models probe failed: 401'));
		const res = await connect(anthropic);
		expect(res.status).toBe(502);
		expect(res.body.message).toMatch(/rejected that API key/);
		expect(listProviders(getDb())).toHaveLength(0);
	});

	it('writes nothing when no chat models come back', async () => {
		fetchModelsForProvider.mockResolvedValue([]);
		const res = await connect(anthropic);
		expect(res.status).toBe(422);
		expect(listProviders(getDb())).toHaveLength(0);
	});

	it('keeps an existing Default chat model', async () => {
		fetchModelsForProvider.mockResolvedValue([{ id: 'one', capabilities: ['chat'] }]);
		await connect(anthropic);
		const first = findRoleModel(getDb(), 'chat')?.id;
		fetchModelsForProvider.mockResolvedValue([{ id: 'two', capabilities: ['chat'] }]);
		const res = await connect({ ...anthropic, name: 'Second' });
		expect(res.body.chatModelId).toBeNull();
		expect(findRoleModel(getDb(), 'chat')?.id).toBe(first);
	});
});
