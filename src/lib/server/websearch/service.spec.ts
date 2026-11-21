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
const { PHOTO_PATH, resetMapsState } = await import('../maps/service.js');
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
const GOOGLE_PLACES = {
	places: [
		{
			displayName: { text: 'Google café' },
			location: { latitude: 1, longitude: 2 },
			photos: [{ name: 'places/g1/photos/p1' }]
		}
	]
};
const GOOGLE_SESSION = { session: 'sess-1', expiry: '4102444800' };

/** Places API (New) and Map Tiles answers. */
const googleBody = (url: string) =>
	url.includes('tile.googleapis.com') ? GOOGLE_SESSION : GOOGLE_PLACES;

function stubFetch(searxngStatus = 200, braveStatus = 200, perplexityStatus = 200) {
	const fetchMock = vi.fn(async (input: unknown) => {
		const url = String(input);
		const [status, body] = url.includes('googleapis.com')
			? [200, googleBody(url)]
			: url.includes('api.search.brave.com')
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

function configure({ searxng = false, brave = false, perplexity = false, google = false } = {}) {
	const db = getDb();
	if (google) setSetting(db, 'maps.google.apiKey', encryptSecret('google-key-4321'));
	if (searxng) setSetting(db, 'websearch.searxng.url', SEARXNG);
	if (brave) setSetting(db, 'websearch.brave.apiKey', encryptSecret('brave-key-1234'));
	if (perplexity) setSetting(db, 'websearch.perplexity.apiKey', encryptSecret('pplx-key-5678'));
}

beforeEach(() => {
	closeDb();
	resetMapsState();
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
	config.GOOGLE_MAPS_API_KEY = undefined;
});

type ProviderKey = 'searxng' | 'brave' | 'perplexity' | 'google';
/** A provider's reply: a body (default: its canned results), a status and a delay, or 'hang'. */
type Route = { status?: number; body?: unknown; delayMs?: number } | 'hang';

/** Answers per provider like the real APIs, and rejects once the request's signal aborts. */
function routeFetch(routes: Partial<Record<ProviderKey, Route>> = {}) {
	const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
		const url = String(input);
		const id: ProviderKey = url.includes('googleapis.com')
			? 'google'
			: url.includes('api.search.brave.com')
				? 'brave'
				: url.includes('api.perplexity.ai')
					? 'perplexity'
					: 'searxng';
		const canned = {
			searxng: SEARXNG_RESULTS,
			brave: url.includes('/news/') ? BRAVE_NEWS : BRAVE_RESULTS,
			perplexity: PERPLEXITY_RESULTS,
			google: googleBody(url)
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
		return url.includes('googleapis.com')
			? 'google'
			: url.includes('brave')
				? 'brave'
				: url.includes('perplexity')
					? 'perplexity'
					: 'searxng';
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
		const [header, ...results] = text.split('\n');
		expect(header).toBe('Results for "q" via SearXNG + Brave Search:');
		expect(results.join('\n')).not.toContain('via');
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
			'Results for "q" via Brave Search (fallback; SearXNG returned HTTP 500):\n\n' +
				'[1] From Brave — b.example\nhttps://b.example/'
		);
	});

	it('gives the model title, site, URL and snippet, and the chat the full cards', async () => {
		configure({ searxng: true });
		routeFetch({
			searxng: {
				body: {
					results: [
						{ url: 'https://s.example/a', title: 'Tour dates', content: 'Next show: Tallinn' },
						// An engine's own redirect link: nothing to fetch or cite.
						{ url: 'http://go/v1/Ac1urFoPHj0', title: 'Redirect' }
					]
				}
			}
		});
		const res = await withServer((client) =>
			client.callTool({ name: 'web_search', arguments: { query: 'q' } })
		);
		const text = (res.content as { text: string }[])[0].text;
		expect(text).toBe(
			'Results for "q" via SearXNG:\n\n[1] Tour dates — s.example\nhttps://s.example/a\nNext show: Tallinn'
		);
		expect(text).not.toContain('favicon');
		expect(res.structuredContent).toEqual({
			sources: [expect.objectContaining({ url: 'https://s.example/a', title: 'Tour dates' })]
		});
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
		expect(tools.search_places).toEqual([
			'latitude',
			'limit',
			'location',
			'longitude',
			'query',
			'radius_m'
		]);
	});

	it('offers places around coordinates with Google', async () => {
		configure({ google: true });
		expect((await listedTools()).search_places).toEqual([
			'latitude',
			'limit',
			'location',
			'longitude',
			'query',
			'radius_m'
		]);
	});

	it('offers places by name only with SearXNG alone', async () => {
		configure({ searxng: true });
		expect((await listedTools()).search_places).toEqual(['limit', 'location', 'query']);
	});
});

describe('searchPlaces', () => {
	const query = { query: 'cafe', location: 'lisbon', limit: 3 };
	const BRAVE_PLACES = { results: [{ title: 'Brave café', coordinates: [1, 2] }] };
	const MAP = { results: [{ title: 'OSM café', latitude: '1', longitude: '2' }] };

	it('needs Brave or SearXNG', async () => {
		configure({ perplexity: true });
		expect(service.placeProviders(getDb())).toEqual([]);
		await expect(service.searchPlaces(getDb(), query)).rejects.toThrow(/Brave.*SearXNG/);
	});

	it('prefers Brave', async () => {
		configure({ searxng: true, brave: true });
		const fetchMock = routeFetch({ brave: { body: BRAVE_PLACES } });
		const outcome = await service.searchPlaces(getDb(), query);
		expect(outcome).toEqual({
			provider: 'brave',
			places: [{ name: 'Brave café', coordinates: [1, 2] }],
			errors: []
		});
		expect(calledProviders(fetchMock)).toEqual(['brave']);
	});

	it('falls back to SearXNG when Brave fails', async () => {
		configure({ searxng: true, brave: true });
		const fetchMock = routeFetch({ brave: { status: 500 }, searxng: { body: MAP } });
		const outcome = await service.searchPlaces(getDb(), query);
		expect(outcome.provider).toBe('searxng');
		expect(outcome.places).toEqual([{ name: 'OSM café', coordinates: [1, 2] }]);
		expect(outcome.errors).toHaveLength(1);
		expect(calledProviders(fetchMock)).toEqual(['brave', 'searxng']);
	});

	it('falls back to SearXNG when Brave finds nothing', async () => {
		configure({ searxng: true, brave: true });
		routeFetch({ brave: { body: { results: [] } }, searxng: { body: MAP } });
		const outcome = await service.searchPlaces(getDb(), query);
		expect(outcome).toMatchObject({
			provider: 'searxng',
			errors: ['Brave Search found no places']
		});
	});

	it('answers empty, not with an error, when no provider finds anything', async () => {
		configure({ searxng: true, brave: true });
		routeFetch({ brave: { body: { results: [] } }, searxng: { body: { results: [] } } });
		expect(await service.searchPlaces(getDb(), query)).toEqual({
			provider: 'brave',
			places: [],
			errors: []
		});
	});

	it('says which providers failed when the others found nothing', async () => {
		configure({ searxng: true, brave: true });
		routeFetch({ brave: { body: { results: [] } }, searxng: { status: 502 } });
		expect(await service.searchPlaces(getDb(), query)).toEqual({
			provider: 'brave',
			places: [],
			errors: ['SearXNG returned HTTP 502']
		});
	});

	it("skips SearXNG for searches it can't run", async () => {
		configure({ searxng: true, brave: true });
		const fetchMock = routeFetch({ brave: { status: 500 } });
		const nearby = { query: 'cafe', latitude: 1, longitude: 2, limit: 3 };
		await expect(service.searchPlaces(getDb(), nearby)).rejects.toThrow(
			/^Brave Search[^;]*; SearXNG skipped \(needs both query and location\)$/
		);
		expect(calledProviders(fetchMock)).toEqual(['brave']);
	});

	it('says why when only SearXNG is configured and the search has no location', async () => {
		configure({ searxng: true });
		await expect(
			service.searchPlaces(getDb(), { query: 'cafe', latitude: 1, longitude: 2, limit: 3 })
		).rejects.toThrow(/location name/);
	});

	it('throws with every reason when all providers fail', async () => {
		configure({ searxng: true, brave: true });
		routeFetch({ brave: { status: 500 }, searxng: { status: 502 } });
		await expect(service.searchPlaces(getDb(), query)).rejects.toThrow(
			/; SearXNG returned HTTP 502/
		);
	});

	it('tries Google first, with photos only the searching user can load', async () => {
		configure({ google: true, searxng: true, brave: true });
		expect(service.placeProviders(getDb())).toEqual(['google', 'brave', 'searxng']);
		const fetchMock = routeFetch();
		const outcome = await service.searchPlaces(getDb(), query, { userId: 'u1' });
		expect(outcome).toMatchObject({ provider: 'google', errors: [] });
		expect(outcome.places).toEqual([
			{
				name: 'Google café',
				coordinates: [1, 2],
				photos: [{ url: expect.stringMatching(new RegExp(`^${PHOTO_PATH}`)) }]
			}
		]);
		expect(calledProviders(fetchMock)).toEqual(['google']);
		const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(input).toBe('https://places.googleapis.com/v1/places:searchText');
		expect(new Headers(init.headers).get('x-goog-api-key')).toBe('google-key-4321');
	});

	it('uses the env Google key and an injected fetch', async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-google';
		const global = routeFetch();
		const injected = vi.fn(async () => new Response(JSON.stringify(GOOGLE_PLACES)));
		const outcome = await service.searchPlaces(getDb(), query, {
			fetchImpl: injected as unknown as typeof fetch
		});
		expect(outcome.provider).toBe('google');
		// Without a user nobody could load the photos.
		expect(outcome.places[0].photos).toBeUndefined();
		expect(injected).toHaveBeenCalledTimes(1);
		expect(global).not.toHaveBeenCalled();
	});

	it('falls back to Brave, then SearXNG, naming Google Maps', async () => {
		configure({ google: true, searxng: true, brave: true });
		const fetchMock = routeFetch({
			google: { status: 403, body: { error: { message: 'API key not valid' } } },
			brave: { body: { results: [] } },
			searxng: { body: MAP }
		});
		const outcome = await service.searchPlaces(getDb(), query, { userId: 'u1' });
		expect(outcome).toEqual({
			provider: 'searxng',
			places: [{ name: 'OSM café', coordinates: [1, 2] }],
			errors: ['Google Places returned HTTP 403: API key not valid', 'Brave Search found no places']
		});
		expect(calledProviders(fetchMock)).toEqual(['google', 'brave', 'searxng']);
	});

	it('falls back to Brave when Google finds nothing', async () => {
		configure({ google: true, brave: true });
		routeFetch({ google: { body: { places: [] } }, brave: { body: BRAVE_PLACES } });
		expect(await service.searchPlaces(getDb(), query)).toEqual({
			provider: 'brave',
			places: [{ name: 'Brave café', coordinates: [1, 2] }],
			errors: ['Google Maps found no places']
		});
	});

	it('answers empty from Google when nobody finds anything', async () => {
		configure({ google: true, brave: true });
		routeFetch({ google: { body: {} }, brave: { body: { results: [] } } });
		expect(await service.searchPlaces(getDb(), query)).toEqual({
			provider: 'google',
			places: [],
			errors: []
		});
	});

	it('throws with the Google reason when Google is the only provider', async () => {
		config.GOOGLE_MAPS_API_KEY = 'env-google';
		const injected = vi.fn(async () => {
			throw new Error('boom');
		});
		await expect(
			service.searchPlaces(getDb(), query, { fetchImpl: injected as unknown as typeof fetch })
		).rejects.toThrow(/^Google Places is unreachable \(boom\)$/);
	});

	it('stops instead of falling back from Google when the caller aborts', async () => {
		configure({ google: true, brave: true });
		const fetchMock = routeFetch({ google: 'hang' });
		const controller = new AbortController();
		const pending = service.searchPlaces(getDb(), { ...query, signal: controller.signal });
		const reason = new Error('turn stopped');
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(calledProviders(fetchMock)).toEqual(['google']);
	});

	it('stops instead of falling back when the caller aborts', async () => {
		configure({ searxng: true, brave: true });
		const fetchMock = routeFetch({ brave: 'hang' });
		const controller = new AbortController();
		const pending = service.searchPlaces(getDb(), { ...query, signal: controller.signal });
		const reason = new Error('turn stopped');
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(calledProviders(fetchMock)).toEqual(['brave']);
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
			)) as { content: Array<{ text: string }>; structuredContent: { sources: unknown[] } };
			expect(output.content[0].text).toContain('via SearXNG');
			expect(output.content[0].text).toContain('\nhttps://a.example/');
			expect(output.structuredContent.sources).toEqual([
				expect.objectContaining({ url: 'https://a.example/' })
			]);
		} finally {
			await after.close();
		}
	});

	it('offers search_places with Brave or SearXNG', async () => {
		configure({ perplexity: true });
		const without = await buildTools({ userId: 'u1', memoryEnabled: false });
		expect(without.tools.search_places).toBeUndefined();
		await without.close();

		configure({ searxng: true });
		const withSearxng = await buildTools({ userId: 'u1', memoryEnabled: false });
		try {
			routeFetch({
				searxng: { body: { results: [{ title: 'OSM café', latitude: 1, longitude: 2 }] } }
			});
			const output = (await withSearxng.tools.search_places.execute!(
				{ query: 'cafe', location: 'lisbon' },
				{ toolCallId: 't1', messages: [], context: {} }
			)) as { content: Array<{ text: string }> };
			expect(output.content[0].text).toBe(
				'Places via SearXNG (OpenStreetMap):\n[1] {"name":"OSM café","coordinates":[1,2]}'
			);
		} finally {
			await withSearxng.close();
		}

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

describe('search_places with Google', () => {
	const description = () =>
		withServer(async (client) => {
			const { tools } = await client.listTools();
			return tools.find((t) => t.name === 'search_places')?.description ?? '';
		});

	it('mentions photos and reviews only when Google answers first', async () => {
		configure({ brave: true });
		expect(await description()).not.toContain('photos and reviews');
		configure({ google: true });
		expect(await description()).toContain('photos and reviews');
	});

	it('answers via Google Maps, with photo URLs for the calling user', async () => {
		configure({ google: true, searxng: true });
		const tools = await buildTools({ userId: 'u1', memoryEnabled: false });
		try {
			routeFetch();
			const output = (await tools.tools.search_places.execute!(
				{ query: 'cafe', location: 'lisbon' },
				{ toolCallId: 't1', messages: [], context: {} }
			)) as { content: Array<{ text: string }> };
			const [header, line] = output.content[0].text.split('\n');
			expect(header).toBe('Places via Google Maps:');
			const place = JSON.parse(line.replace(/^\[1\] /, ''));
			expect(place).toEqual({
				name: 'Google café',
				coordinates: [1, 2],
				photos: [{ url: expect.stringMatching(new RegExp(`^${PHOTO_PATH}[\\w-]+$`)) }]
			});
		} finally {
			await tools.close();
		}
	});

	it('is offered with a Google Maps key alone, without web_search', async () => {
		configure({ google: true });
		const tools = await buildTools({ userId: 'u1', memoryEnabled: false });
		try {
			expect(tools.toolToServer.search_places).toBe('websearch');
			expect(tools.tools.web_search).toBeUndefined();
		} finally {
			await tools.close();
		}
	});

	it('notes the fallback when Google fails', async () => {
		configure({ google: true, searxng: true });
		routeFetch({
			google: { status: 500, body: {} },
			searxng: { body: { results: [{ title: 'OSM café', latitude: 1, longitude: 2 }] } }
		});
		const text = await withServer(async (client) => {
			const res = await client.callTool({
				name: 'search_places',
				arguments: { query: 'cafe', location: 'lisbon' }
			});
			return (res.content as { text: string }[])[0].text;
		});
		expect(text.split('\n')[0]).toBe(
			'Places via SearXNG (OpenStreetMap) (fallback; Google Places returned HTTP 500):'
		);
	});
});
