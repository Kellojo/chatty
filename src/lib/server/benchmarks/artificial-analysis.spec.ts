import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../db/index.js');
const { countAaModels, listAaModels } = await import('../db/repo/aa-models.js');
const aaModule = await import('./artificial-analysis.js');
const { clearApiKey, getKeyInfo, getStatus, refreshScores, saveApiKey, _resetForTests } = aaModule;

type Db = ReturnType<typeof openDatabase>;

const page = (n: number, hasMore: boolean) => ({
	tier: 'free',
	intelligence_index_version: 5,
	pagination: { page: n, has_more: hasMore },
	data: [
		{
			id: `uuid-${n}`,
			slug: `model-${n}`,
			name: `Model ${n}`,
			release_date: '2026-08-18',
			model_creator: { id: 'c', name: 'Maker' },
			evaluations: { artificial_analysis_intelligence_index: 30 + n }
		}
	]
});

function okFetch() {
	return vi.fn<typeof fetch>(async (url) => {
		const n = Number(new URL(String(url)).searchParams.get('page'));
		return Response.json(page(n, n < 2));
	});
}

let db: Db;
beforeEach(() => {
	db = openDatabase(':memory:');
	_resetForTests();
});
afterEach(() => {
	db.close();
	vi.useRealTimers();
});

describe('saveApiKey', () => {
	it('verifies the key with a full fetch, then stores it encrypted', async () => {
		const fetchImpl = okFetch();
		const status = await saveApiKey(db, 'key-abcd', fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ 'x-api-key': 'key-abcd' });
		expect(status).toMatchObject({ indexVersion: 5, modelCount: 2, lastError: null });
		expect(listAaModels(db).map((m) => m.intelligenceIndex)).toEqual([31, 32]);
		expect(getKeyInfo(db)).toEqual({ source: 'app', hint: 'abcd' });
		const raw = db.prepare("SELECT value FROM settings WHERE key = 'aa.apiKey'").get() as {
			value: string;
		};
		expect(raw.value).not.toContain('key-abcd');
	});

	it('rejects a bad key and keeps nothing', async () => {
		const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
		await expect(saveApiKey(db, 'bad', fetchImpl)).rejects.toThrow('rejected the API key');
		expect(getKeyInfo(db).source).toBeNull();
		expect(getStatus(db).lastError).toBeNull();
	});

	it('clearing the key drops the cache and status too', async () => {
		await saveApiKey(db, 'key-abcd', okFetch());
		clearApiKey(db);
		expect(getKeyInfo(db).source).toBeNull();
		expect(countAaModels(db)).toBe(0);
		expect(getStatus(db).fetchedAt).toBeNull();
	});
});

describe('refreshScores', () => {
	it('does nothing without a key', async () => {
		const fetchImpl = okFetch();
		const outcome = await refreshScores(db, 'sync', fetchImpl);
		expect(outcome).toMatchObject({ state: 'skipped', reason: 'no-key' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('skips sync refreshes within the cooldown, allows them after', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		await saveApiKey(db, 'key-abcd', okFetch());
		const fetchImpl = okFetch();
		expect(await refreshScores(db, 'sync', fetchImpl)).toMatchObject({ reason: 'cooldown' });
		expect(fetchImpl).not.toHaveBeenCalled();
		vi.setSystemTime(Date.now() + 61 * 60 * 1000);
		expect((await refreshScores(db, 'sync', fetchImpl)).state).toBe('updated');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('shares one fetch between overlapping triggers', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		await saveApiKey(db, 'key-abcd', okFetch());
		vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
		const fetchImpl = okFetch();
		const [a, b] = await Promise.all([
			refreshScores(db, 'sync', fetchImpl),
			refreshScores(db, 'manual', fetchImpl)
		]);
		expect([a.state, b.state]).toEqual(['updated', 'updated']);
		expect(fetchImpl).toHaveBeenCalledTimes(2); // two pages, one refresh
	});

	it('records a 429 and waits out Retry-After', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		await saveApiKey(db, 'key-abcd', okFetch());
		vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
		const limited = vi.fn(
			async () => new Response('slow down', { status: 429, headers: { 'retry-after': '600' } })
		);
		const outcome = await refreshScores(db, 'manual', limited);
		expect(outcome.state).toBe('failed');
		expect(outcome.status.retryAfter).toBe(Date.now() + 600_000);
		expect(countAaModels(db)).toBe(2); // the old scores stay

		const fetchImpl = okFetch();
		expect(await refreshScores(db, 'manual', fetchImpl)).toMatchObject({
			reason: 'rate-limited'
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
