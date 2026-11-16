import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { getDb, closeDb } = await import('../db/index.js');
const { getSetting, setSetting } = await import('../db/repo/settings.js');
const { encryptSecret } = await import('../crypto.js');
const { config } = await import('../config.js');
const { buildTools } = await import('../tools/registry.js');
const service = await import('./service.js');
const { createWebsearchServer } = await import('../mcp/servers/websearch.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

/** The tools the websearch server lists right now, with their input properties. */
async function listedTools(): Promise<Record<string, string[]>> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createWebsearchServer();
	await server.connect(serverTransport);
	const client = new Client({ name: 'websearch-spec', version: '0' });
	await client.connect(clientTransport);
	try {
		const { tools } = await client.listTools();
		return Object.fromEntries(
			tools.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {}).sort()])
		);
	} finally {
		await client.close();
		await server.close();
	}
}

const SEARXNG = 'http://searxng.local:8080';
const SEARXNG_RESULTS = { results: [{ url: 'https://a.example/', title: 'From SearXNG' }] };
const BRAVE_RESULTS = { web: { results: [{ url: 'https://b.example/', title: 'From Brave' }] } };
const BRAVE_NEWS = { results: [{ url: 'https://n.example/', title: 'Brave news' }] };
const PERPLEXITY_RESULTS = { results: [{ url: 'https://p.example/', title: 'From Perplexity' }] };

function stubFetch(searxngStatus = 200, braveStatus = 200, perplexityStatus = 200) {
	const fetchMock = vi.fn(async (input: unknown) => {
		const url = String(input);
		const [status, body] = url.includes('api.search.brave.com')
			? [braveStatus, url.includes('/news/') ? BRAVE_NEWS : BRAVE_RESULTS]
			: url.includes('api.perplexity.ai')
				? [perplexityStatus, PERPLEXITY_RESULTS]
				: [searxngStatus, SEARXNG_RESULTS];
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function configure({ searxng = false, brave = false, perplexity = false } = {}) {
	const db = getDb();
	if (searxng) setSetting(db, 'websearch.searxng.url', SEARXNG);
	if (brave) setSetting(db, 'websearch.brave.apiKey', encryptSecret('brave-key-1234'));
	if (perplexity) setSetting(db, 'websearch.perplexity.apiKey', encryptSecret('pplx-key-5678'));
}

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
			 VALUES ('u1', 'A', 'a@example.com', 0, 0, 0, 'user')`
		)
		.run();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	config.SEARXNG_URL = undefined;
	config.BRAVE_SEARCH_API_KEY = undefined;
	config.PERPLEXITY_API_KEY = undefined;
});

type ProviderKey = 'searxng' | 'brave' | 'perplexity';
/** A provider's reply: a body (default: its canned results), a status and a delay, or 'hang'. */
type Route = { status?: number; body?: unknown; delayMs?: number } | 'hang';

/** Answers per provider like the real APIs, and rejects once the request's signal aborts. */
function routeFetch(routes: Partial<Record<ProviderKey, Route>> = {}) {
	const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
		const url = String(input);
		const id: ProviderKey = url.includes('api.search.brave.com')
			? 'brave'
			: url.includes('api.perplexity.ai')
				? 'perplexity'
				: 'searxng';
		const canned = {
			searxng: SEARXNG_RESULTS,
			brave: url.includes('/news/') ? BRAVE_NEWS : BRAVE_RESULTS,
			perplexity: PERPLEXITY_RESULTS
		}[id];
		const route = routes[id] ?? {};
		return new Promise<Response>((resolve, reject) => {
			const signal = init?.signal;
			signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			if (route === 'hang') return;
			const respond = () =>
				resolve(
					new Response(JSON.stringify(route.body ?? canned), {
						status: route.status ?? 200,
						headers: { 'content-type': 'application/json' }
					})
				);
			if (route.delayMs) setTimeout(respond, route.delayMs);
			else respond();
		});
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

const calledProviders = (fetchMock: ReturnType<typeof routeFetch>) =>
	fetchMock.mock.calls.map(([input]) => {
		const url = String(input);
		return url.includes('brave') ? 'brave' : url.includes('perplexity') ? 'perplexity' : 'searxng';
	});

const statuses = (outcome: { providers: { id: string; status: string; backup: boolean }[] }) =>
	outcome.providers.map((p) => `${p.id}:${p.status}${p.backup ? ':backup' : ''}`);

describe('provider configuration', () => {
	it('reports nothing configured by default, in Combined mode', () => {
		const db = getDb();
		expect(service.isWebSearchConfigured(db)).toBe(false);
		expect(service.getWebSearchInfo(db)).toEqual({
			searxng: { source: null, url: null },
			brave: { source: null, hint: null },
			perplexity: { source: null, hint: null },
			defaultProvider: null,
			mode: 'combined',
			backupOnly: [],
			order: { fallback: [], combined: [], backup: [] }
		});
	});

	it('prefers SearXNG until another default is picked', () => {
		const db = getDb();
		configure({ searxng: true, brave: true, perplexity: true });
		expect(service.configuredProviders(db)).toEqual(['searxng', 'brave', 'perplexity']);
		service.setSearchPreferences(db, { defaultProvider: 'perplexity' });
		expect(service.configuredProviders(db)).toEqual(['perplexity', 'searxng', 'brave']);
		expect(service.getWebSearchInfo(db).brave).toEqual({ source: 'app', hint: '1234' });
		expect(service.getWebSearchInfo(db).perplexity).toEqual({ source: 'app', hint: '5678' });
	});

	it('lets env vars override saved values', () => {
		const db = getDb();
		configure({ searxng: true });
		config.SEARXNG_URL = 'http://env-searxng:8080/';
		config.BRAVE_SEARCH_API_KEY = 'env-key-9999';
		config.PERPLEXITY_API_KEY = 'env-pplx-4321';
		const info = service.getWebSearchInfo(db);
		expect(info.searxng).toEqual({ source: 'env', url: 'http://env-searxng:8080' });
		expect(info.brave).toEqual({ source: 'env', hint: '9999' });
		expect(info.perplexity).toEqual({ source: 'env', hint: '4321' });
	});

	it('stores the Brave key encrypted, only after it worked', async () => {
		const db = getDb();
		stubFetch(200, 401);
		await expect(service.saveApiKey(db, 'brave', 'bad-key')).rejects.toThrow(/rejected/);
		expect(getSetting(db, 'websearch.brave.apiKey')).toBeUndefined();
		stubFetch();
		await service.saveApiKey(db, 'brave', 'good-key');
		expect(getSetting<string>(db, 'websearch.brave.apiKey')).not.toContain('good-key');
		expect(service.getApiKey(db, 'brave')).toBe('good-key');
	});
});

describe('search order', () => {
	it('runs Combined in the fixed order and Fallback from the default', () => {
		const db = getDb();
		configure({ searxng: true, brave: true, perplexity: true });
		service.setSearchPreferences(db, { defaultProvider: 'brave', backupOnly: ['perplexity'] });
		expect(service.searchOrder(db)).toEqual({
			fallback: ['brave', 'searxng', 'perplexity'],
			combined: ['searxng', 'brave'],
			backup: ['perplexity']
		});
		// Perplexity can't search news, so it has no part in a news search.
		expect(service.searchOrder(db, 'news')).toEqual({
			fallback: ['brave', 'searxng'],
			combined: ['searxng', 'brave'],
			backup: []
		});
	});

	it('searches normally when every provider is Backup only', () => {
		const db = getDb();
		configure({ searxng: true, brave: true });
		service.setSearchPreferences(db, { backupOnly: ['searxng', 'brave'] });
		expect(service.searchOrder(db)).toMatchObject({ combined: ['searxng', 'brave'], backup: [] });
	});

	it('reads a malformed Backup only setting as empty', () => {
		const db = getDb();
		configure({ searxng: true, brave: true });
		setSetting(db, 'websearch.backupOnly', 'brave');
		expect(service.getBackupOnly(db)).toEqual([]);
		setSetting(db, 'websearch.backupOnly', ['google', 'brave']);
		expect(service.getBackupOnly(db)).toEqual(['brave']);
	});

	it("keeps a disconnected provider's Backup only setting", () => {
		const db = getDb();
		configure({ searxng: true });
		service.setSearchPreferences(db, { backupOnly: ['perplexity', 'brave'] });
		expect(service.getBackupOnly(db)).toEqual(['brave', 'perplexity']);
	});
});

describe('webSearch, Combined mode', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('is the default, searches every provider and merges the results', async () => {
		const db = getDb();
		configure({ searxng: true, brave: true, perplexity: true });
		// The default only matters in Fallback.
		service.setSearchPreferences(db, { defaultProvider: 'perplexity' });
		const fetchMock = routeFetch({
			searxng: {
				body: {
					results: [
						{ url: 'https://only-searxng.example/', title: 'SearXNG only' },
						{ url: 'https://shared.example/page', title: 'Shared' }
					]
				}
			},
			brave: {
				body: { web: { results: [{ url: 'https://www.shared.example/page/', title: 'Shared' }] } }
			}
		});
		const outcome = await service.webSearch(db, 'q', { limit: 5 });
		expect(outcome.mode).toBe('combined');
		expect(calledProviders(fetchMock)).toEqual(['searxng', 'brave', 'perplexity']);
		expect(statuses(outcome)).toEqual(['searxng:ok', 'brave:ok', 'perplexity:ok']);
		expect(outcome.results.map((r) => [r.card.title, r.via])).toEqual([
			['Shared', ['searxng', 'brave']],
			['SearXNG only', ['searxng']],
			['From Perplexity', ['perplexity']]
		]);
	});

	it('answers with what came back when a provider fails or is cut off', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		configure({ searxng: true, brave: true, perplexity: true });
		routeFetch({ brave: { status: 429, body: {} }, perplexity: 'hang' });
		const pending = service.webSearch(getDb(), 'q', { limit: 5 });
		// SearXNG answered with results: the others get the 3 s grace window, then are cut off.
		await vi.advanceTimersByTimeAsync(service.GRACE_MS);
		const outcome = await pending;
		expect(statuses(outcome)).toEqual(['searxng:ok', 'brave:failed', 'perplexity:timed out']);
		expect(outcome.providers.map((p) => p.error)).toEqual([
			undefined,
			'Brave Search rate limit reached',
			'Perplexity timed out'
		]);
		expect(outcome.results.map((r) => r.card.title)).toEqual(['From SearXNG']);
	});

	it("doesn't start the grace window on an empty answer", async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		configure({ searxng: true, brave: true });
		routeFetch({ searxng: { body: { results: [] } }, brave: { delayMs: 5_000 } });
		const pending = service.webSearch(getDb(), 'q', { limit: 5 });
		await vi.advanceTimersByTimeAsync(5_000);
		const outcome = await pending;
		expect(statuses(outcome)).toEqual(['searxng:ok', 'brave:ok']);
		expect(outcome.results.map((r) => r.card.title)).toEqual(['From Brave']);
	});

	it('cuts every provider off at the round limit and fails when none answered', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		configure({ searxng: true, brave: true });
		routeFetch({ searxng: 'hang', brave: 'hang' });
		const pending = service.webSearch(getDb(), 'q', { limit: 5 });
		const failure = expect(pending).rejects.toThrow('SearXNG timed out; Brave Search timed out');
		await vi.advanceTimersByTimeAsync(service.ROUND_TIMEOUT_MS);
		await failure;
	});

	it('uses Backup only providers only when no other provider answers', async () => {
		const db = getDb();
		configure({ searxng: true, brave: true, perplexity: true });
		service.setSearchPreferences(db, { backupOnly: ['perplexity'] });

		const answered = routeFetch();
		const normal = await service.webSearch(db, 'q', { limit: 5 });
		expect(calledProviders(answered)).toEqual(['searxng', 'brave']);
		expect(statuses(normal)).toEqual(['searxng:ok', 'brave:ok', 'perplexity:skipped:backup']);

		const failing = routeFetch({
			searxng: { status: 500, body: {} },
			brave: { status: 429, body: {} }
		});
		const backup = await service.webSearch(db, 'q', { limit: 5 });
		expect(calledProviders(failing)).toEqual(['searxng', 'brave', 'perplexity']);
		expect(statuses(backup)).toEqual(['searxng:failed', 'brave:failed', 'perplexity:ok:backup']);
		expect(backup.results.map((r) => r.card.title)).toEqual(['From Perplexity']);
	});

	it('skips providers without news search', async () => {
		configure({ brave: true, perplexity: true });
		const fetchMock = routeFetch();
		const outcome = await service.webSearch(getDb(), 'q', { limit: 5, type: 'news' });
		expect(calledProviders(fetchMock)).toEqual(['brave']);
		expect(outcome.results[0].card.title).toBe('Brave news');
	});

	it('says when no configured provider can search news', async () => {
		configure({ perplexity: true });
		await expect(service.webSearch(getDb(), 'q', { limit: 5, type: 'news' })).rejects.toThrow(
			/news search needs SearXNG or Brave/
		);
	});

	it('stops every request when the caller aborts, without a backup round', async () => {
		const db = getDb();
		configure({ searxng: true, brave: true, perplexity: true });
		service.setSearchPreferences(db, { backupOnly: ['perplexity'] });
		const fetchMock = routeFetch({ searxng: 'hang', brave: 'hang' });
		const controller = new AbortController();
		const reason = new Error('turn stopped');
		const pending = service.webSearch(db, 'q', { limit: 5, signal: controller.signal });
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(calledProviders(fetchMock)).toEqual(['searxng', 'brave']);
	});
});

describe('webSearch, Fallback mode', () => {
	beforeEach(() => {
		service.setSearchPreferences(getDb(), { mode: 'fallback' });
	});

	it('uses the default provider alone', async () => {
		configure({ searxng: true, brave: true });
		const fetchMock = routeFetch();
		const outcome = await service.webSearch(getDb(), 'q', { limit: 5 });
		expect(outcome.mode).toBe('fallback');
		expect(calledProviders(fetchMock)).toEqual(['searxng']);
		expect(statuses(outcome)).toEqual(['searxng:ok', 'brave:skipped']);
		expect(outcome.results.map((r) => [r.card.title, r.via])).toEqual([
			['From SearXNG', ['searxng']]
		]);
	});

	it('tries the next provider when one fails, Backup only ones last', async () => {
		const db = getDb();
		configure({ searxng: true, brave: true, perplexity: true });
		service.setSearchPreferences(db, { defaultProvider: 'brave', backupOnly: ['searxng'] });
		routeFetch({ brave: { status: 429, body: {} }, perplexity: { status: 500, body: {} } });
		const outcome = await service.webSearch(db, 'q', { limit: 5 });
		expect(statuses(outcome)).toEqual(['brave:failed', 'perplexity:failed', 'searxng:ok:backup']);
		expect(outcome.results[0].card.title).toBe('From SearXNG');
	});

	it('throws when every provider fails or none is configured', async () => {
		await expect(service.webSearch(getDb(), 'q', { limit: 5 })).rejects.toThrow(/not configured/);
		configure({ searxng: true, brave: true });
		routeFetch({ searxng: { status: 500, body: {} }, brave: { status: 429, body: {} } });
		await expect(service.webSearch(getDb(), 'q', { limit: 5 })).rejects.toThrow(
			/HTTP 500.*rate limit/
		);
	});

	it('stops instead of trying the next provider when the caller aborts', async () => {
		configure({ searxng: true, brave: true });
		const fetchMock = routeFetch({ searxng: 'hang' });
		const controller = new AbortController();
		const reason = new Error('turn stopped');
		const pending = service.webSearch(getDb(), 'q', { limit: 5, signal: controller.signal });
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(calledProviders(fetchMock)).toEqual(['searxng']);
	});
});

/** Runs the websearch server with an MCP client: `call` invokes a tool, `description` reads one. */
async function withServer<T>(run: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createWebsearchServer();
	await server.connect(serverTransport);
	const client = new Client({ name: 'websearch-spec', version: '0' });
	await client.connect(clientTransport);
	try {
		return await run(client);
	} finally {
		await client.close();
		await server.close();
	}
}

const webSearchText = (args: Record<string, unknown>) =>
	withServer(async (client) => {
		const res = await client.callTool({ name: 'web_search', arguments: args });
		return (res.content as { text: string }[])[0].text;
	});

const webSearchDescription = () =>
	withServer(async (client) => {
		const { tools } = await client.listTools();
		return tools.find((t) => t.name === 'web_search')?.description ?? '';
	});

describe('web_search output', () => {
	it('names every provider that answered and which ones found each result', async () => {
		configure({ searxng: true, brave: true, perplexity: true });
		routeFetch({
			searxng: { body: { results: [{ url: 'https://s.example/', title: 'S' }] } },
			brave: { body: { web: { results: [{ url: 'https://s.example/', title: 'S' }] } } },
			perplexity: { status: 429, body: {} }
		});
		const text = await webSearchText({ query: 'q' });
		expect(text.split('\n')[0]).toBe(
			'Results for "q" via SearXNG + Brave Search (Perplexity rate limit reached):'
		);
		expect(text).toContain('(via SearXNG, Brave Search)');
	});

	it('leaves out via when one provider found everything, but still names who answered', async () => {
		configure({ searxng: true, brave: true });
		routeFetch({ brave: { body: { web: { results: [] } } } });
		const text = await webSearchText({ query: 'q' });
		const [header, line] = text.split('\n');
		expect(header).toBe('Results for "q" via SearXNG + Brave Search:');
		expect(line).not.toContain('via');
	});

	it('marks an answer from the backup round', async () => {
		const db = getDb();
		configure({ searxng: true, brave: true, perplexity: true });
		service.setSearchPreferences(db, { backupOnly: ['perplexity'] });
		routeFetch({ searxng: { status: 500, body: {} }, brave: { status: 429, body: {} } });
		const text = await webSearchText({ query: 'q' });
		expect(text.split('\n')[0]).toBe(
			'Results for "q" via Perplexity (backup; SearXNG returned HTTP 500; Brave Search rate limit reached):'
		);
	});

	it('keeps the Fallback wording', async () => {
		configure({ searxng: true, brave: true });
		service.setSearchPreferences(getDb(), { mode: 'fallback' });
		routeFetch({ searxng: { status: 500, body: {} } });
		const text = await webSearchText({ query: 'q' });
		expect(text).toBe(
			'Results for "q" via Brave Search (fallback; SearXNG returned HTTP 500):\n' +
				`[1] {"url":"https://b.example/","title":"From Brave","site":"b.example","favicon":"https://b.example/favicon.ico"}`
		);
	});

	it('explains via only when results can come from several providers', async () => {
		configure({ searxng: true });
		expect(await webSearchDescription()).not.toContain('"via"');
		configure({ brave: true });
		expect(await webSearchDescription()).toContain('"via"');
		service.setSearchPreferences(getDb(), { mode: 'fallback' });
		expect(await webSearchDescription()).not.toContain('"via"');
	});
});

describe('websearch server tools', () => {
	it('lists no tools while no provider is configured', async () => {
		expect(await listedTools()).toEqual({});
	});

	it('leaves out news when no configured provider can search it', async () => {
		configure({ perplexity: true });
		expect(await listedTools()).toEqual({ web_search: ['limit', 'query', 'time_range'] });
	});

	it('offers news, and places with Brave', async () => {
		configure({ brave: true });
		const tools = await listedTools();
		expect(tools.web_search).toContain('type');
		expect(tools.search_places).toContain('location');
	});
});

describe('web_search tool registration', () => {
	it('is only offered to models once a provider is configured', async () => {
		const before = await buildTools({ userId: 'u1', memoryEnabled: false });
		expect(before.tools.web_search).toBeUndefined();
		await before.close();

		configure({ searxng: true });
		const after = await buildTools({ userId: 'u1', memoryEnabled: false });
		try {
			expect(after.toolToServer.web_search).toBe('websearch');
			expect(after.deferred.has('web_search')).toBe(false);
			stubFetch();
			const output = (await after.tools.web_search.execute!(
				{ query: 'svelte' },
				{ toolCallId: 't1', messages: [], context: {} }
			)) as { content: Array<{ text: string }> };
			expect(output.content[0].text).toContain('via SearXNG');
			expect(output.content[0].text).toContain('"url":"https://a.example/"');
		} finally {
			await after.close();
		}
	});

	it('offers search_places only with a Brave key', async () => {
		configure({ searxng: true });
		const without = await buildTools({ userId: 'u1', memoryEnabled: false });
		expect(without.tools.search_places).toBeUndefined();
		await without.close();

		configure({ brave: true });
		const withBrave = await buildTools({ userId: 'u1', memoryEnabled: false });
		try {
			expect(withBrave.toolToServer.search_places).toBe('websearch');
			const missing = (await withBrave.tools.search_places.execute!(
				{ query: 'coffee' },
				{ toolCallId: 't1', messages: [], context: {} }
			)) as { content: Array<{ text: string }> };
			expect(missing.content[0].text).toMatch(/location or both latitude and longitude/);
		} finally {
			await withBrave.close();
		}
	});
});
