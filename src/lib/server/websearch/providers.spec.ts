import { describe, expect, it, vi } from 'vitest';
import {
	BRAVE_API,
	normalizeSearxngUrl,
	searchBrave,
	searchPerplexity,
	searchPlaces,
	searchSearxng,
	PERPLEXITY_ENDPOINT,
	verifySearxng,
	WebSearchError,
	type FetchImpl
} from './providers.js';

type Reply = { status?: number; body: unknown; contentType?: string };

function mockFetch(reply: Reply | ((url: URL, init?: RequestInit) => Reply)) {
	return vi.fn(async (input: unknown, init?: RequestInit) => {
		const {
			status = 200,
			body,
			contentType = 'application/json'
		} = typeof reply === 'function' ? reply(new URL(String(input)), init) : reply;
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'content-type': contentType }
		});
	});
}

const asFetch = (f: ReturnType<typeof mockFetch>) => f as unknown as FetchImpl;

describe('normalizeSearxngUrl', () => {
	it('keeps the instance root and drops a pasted /search, query and trailing slashes', () => {
		expect(normalizeSearxngUrl(' http://searxng:8080/ ')).toBe('http://searxng:8080');
		expect(normalizeSearxngUrl('https://example.com/searx/search?q=x#y')).toBe(
			'https://example.com/searx'
		);
	});

	it('rejects non-http URLs and garbage', () => {
		expect(() => normalizeSearxngUrl('ftp://host')).toThrow(/http/);
		expect(() => normalizeSearxngUrl('searxng')).toThrow(/full URL/);
	});
});

describe('searchSearxng', () => {
	const RESULTS = {
		results: [
			{
				url: 'https://www.example.com/a',
				title: 'Example &amp; A',
				content: 'An <b>example</b>   page',
				publishedDate: '2026-01-02T00:00:00',
				thumbnail: 'https://img.example.com/t.png'
			},
			{ url: 'javascript:alert(1)', title: 'Bad' },
			{ url: 'https://b.example.org/', title: '' },
			{ url: 'https://c.example.org/', title: 'C' }
		]
	};

	it('queries the JSON API and maps results to source cards', async () => {
		const fetchImpl = mockFetch({ body: RESULTS });
		const results = await searchSearxng(
			'http://searxng:8080',
			'svelte runes',
			{ limit: 5, timeRange: 'week' },
			asFetch(fetchImpl)
		);
		const url = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(url.origin + url.pathname).toBe('http://searxng:8080/search');
		expect(url.searchParams.get('q')).toBe('svelte runes');
		expect(url.searchParams.get('format')).toBe('json');
		expect(url.searchParams.get('time_range')).toBe('week');
		expect(results).toEqual([
			{
				card: {
					url: 'https://www.example.com/a',
					title: 'Example & A',
					site: 'example.com',
					description: 'An example page',
					favicon: 'https://www.example.com/favicon.ico',
					image: 'https://img.example.com/t.png'
				},
				published: '2026-01-02T00:00:00'
			},
			{
				card: {
					url: 'https://c.example.org/',
					title: 'C',
					site: 'c.example.org',
					favicon: 'https://c.example.org/favicon.ico'
				},
				published: undefined
			}
		]);
	});

	it('caps the number of results', async () => {
		const fetchImpl = mockFetch({ body: RESULTS });
		const results = await searchSearxng('http://s', 'q', { limit: 1 }, asFetch(fetchImpl));
		expect(results).toHaveLength(1);
	});

	it('explains the json format setting on 403 and on HTML answers', async () => {
		await expect(
			verifySearxng('http://s', asFetch(mockFetch({ status: 403, body: 'Forbidden' })))
		).rejects.toThrow(/search\.formats/);
		await expect(
			verifySearxng(
				'http://s',
				asFetch(mockFetch({ body: '<!doctype html><html></html>', contentType: 'text/html' }))
			)
		).rejects.toThrow(/search\.formats/);
	});

	it('reports unreachable instances and other HTTP errors', async () => {
		const down = vi.fn(async () => {
			throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
		});
		await expect(verifySearxng('http://s', down as unknown as FetchImpl)).rejects.toThrow(
			/unreachable.*ECONNREFUSED/
		);
		await expect(
			verifySearxng('http://s', asFetch(mockFetch({ status: 500, body: 'x' })))
		).rejects.toThrow(/HTTP 500/);
		await expect(
			verifySearxng('http://s', asFetch(mockFetch({ body: { nope: true } })))
		).rejects.toThrow(/no results list/);
	});

	it('treats no results with every engine failing as an error', async () => {
		const fetchImpl = mockFetch({
			body: { results: [], unresponsive_engines: [['google', 'timeout']] }
		});
		const search = searchSearxng('http://s', 'q', { limit: 5 }, asFetch(fetchImpl));
		await expect(search).rejects.toThrow(/google \(timeout\)/);
		await expect(
			searchSearxng('http://s', 'q', { limit: 5 }, asFetch(mockFetch({ body: { results: [] } })))
		).resolves.toEqual([]);
	});
});

describe('searchBrave', () => {
	const RESULTS = {
		web: {
			results: [
				{
					url: 'https://svelte.dev/docs',
					title: 'Svelte docs',
					description: 'All about <strong>runes</strong>',
					page_age: '2026-03-01T00:00:00',
					profile: { name: 'Svelte' },
					meta_url: { favicon: 'https://imgs.search.brave.com/fav.png' },
					thumbnail: { src: 'https://imgs.search.brave.com/thumb.png' }
				}
			]
		}
	};

	it('sends the key and maps results to source cards', async () => {
		const fetchImpl = mockFetch({ body: RESULTS });
		const results = await searchBrave(
			'k-123',
			'runes',
			{ limit: 50, timeRange: 'day' },
			asFetch(fetchImpl)
		);
		const [input, init] = fetchImpl.mock.calls[0];
		const url = new URL(String(input));
		expect(url.origin + url.pathname).toBe(`${BRAVE_API}/web/search`);
		expect(url.searchParams.get('q')).toBe('runes');
		expect(url.searchParams.get('count')).toBe('20');
		expect(url.searchParams.get('freshness')).toBe('pd');
		expect(new Headers(init?.headers).get('x-subscription-token')).toBe('k-123');
		expect(results).toEqual([
			{
				card: {
					url: 'https://svelte.dev/docs',
					title: 'Svelte docs',
					site: 'Svelte',
					description: 'All about runes',
					favicon: 'https://imgs.search.brave.com/fav.png',
					image: 'https://imgs.search.brave.com/thumb.png'
				},
				published: '2026-03-01T00:00:00'
			}
		]);
	});

	it('flags a rejected key', async () => {
		for (const reply of [
			{ status: 401, body: {} },
			{ status: 422, body: { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'bad' } } }
		]) {
			const error = await searchBrave('bad', 'q', { limit: 1 }, asFetch(mockFetch(reply))).catch(
				(e: unknown) => e
			);
			expect(error).toBeInstanceOf(WebSearchError);
			expect((error as WebSearchError).rejected).toBe(true);
			expect((error as Error).message).toMatch(/rejected the API key/);
		}
	});

	it('reports rate limits and other failures', async () => {
		await expect(
			searchBrave('k', 'q', { limit: 1 }, asFetch(mockFetch({ status: 429, body: {} })))
		).rejects.toThrow(/rate limit/);
		await expect(
			searchBrave(
				'k',
				'q',
				{ limit: 1 },
				asFetch(
					mockFetch({ status: 422, body: { error: { code: 'VALIDATION', detail: 'bad q' } } })
				)
			)
		).rejects.toThrow(/422: bad q/);
	});
});

describe('news search', () => {
	it('uses the news category on SearXNG', async () => {
		const fetchImpl = mockFetch({ body: { results: [] } });
		await searchSearxng('http://s', 'q', { limit: 5, type: 'news' }, asFetch(fetchImpl));
		const url = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(url.searchParams.get('categories')).toBe('news');
	});

	it("uses Brave's news endpoint, whose results sit at the top level", async () => {
		const fetchImpl = mockFetch({
			body: {
				type: 'news',
				results: [
					{
						url: 'https://news.example/a',
						title: 'Breaking',
						description: 'Something happened',
						age: '2 hours ago',
						meta_url: { hostname: 'news.example', favicon: 'https://imgs.example/f.png' }
					}
				]
			}
		});
		const results = await searchBrave(
			'k',
			'q',
			{ limit: 5, type: 'news', timeRange: 'week' },
			asFetch(fetchImpl)
		);
		const url = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(url.origin + url.pathname).toBe(`${BRAVE_API}/news/search`);
		expect(url.searchParams.get('freshness')).toBe('pw');
		expect(results).toEqual([
			{
				card: {
					url: 'https://news.example/a',
					title: 'Breaking',
					site: 'news.example',
					description: 'Something happened',
					favicon: 'https://imgs.example/f.png'
				},
				published: '2 hours ago'
			}
		]);
	});
});

describe('searchPlaces', () => {
	const PLACES = {
		type: 'locations',
		results: [
			{
				type: 'location_result',
				id: 'loc1',
				title: 'Blue Bottle Coffee',
				url: 'https://bluebottlecoffee.com',
				provider_url: 'https://yelp.com/biz/blue-bottle-coffee-sf',
				coordinates: [37.7825, -122.4095],
				postal_address: { displayAddress: '66 Mint St, San Francisco, CA 94103' },
				rating: { ratingValue: 4.5, bestRating: 5.0, reviewCount: 1250 },
				opening_hours: {
					current_day: [{ abbr_name: 'Tue', opens: '07:00', closes: '18:00' }]
				},
				contact: { telephone: '+1 510-653-3394' },
				distance: { value: 0.3, units: 'km' },
				categories: ['Coffee & Tea', 'Cafe'],
				price_range: '$$'
			},
			{ type: 'location_result', id: 'loc2' }
		]
	};

	it('searches around coordinates and trims places for the model', async () => {
		const fetchImpl = mockFetch({ body: PLACES });
		const places = await searchPlaces(
			'k',
			{ query: 'coffee', latitude: 37.77, longitude: -122.41, radius: 1000, limit: 5 },
			asFetch(fetchImpl)
		);
		const url = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(url.origin + url.pathname).toBe(`${BRAVE_API}/local/place_search`);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			count: '5',
			q: 'coffee',
			latitude: '37.77',
			longitude: '-122.41',
			radius: '1000'
		});
		expect(places).toEqual([
			{
				name: 'Blue Bottle Coffee',
				address: '66 Mint St, San Francisco, CA 94103',
				categories: ['Coffee & Tea', 'Cafe'],
				rating: '4.5/5 (1250 reviews)',
				price: '$$',
				phone: '+1 510-653-3394',
				hoursToday: '07:00–18:00',
				distance: '0.3 km',
				coordinates: [37.7825, -122.4095],
				website: 'https://bluebottlecoffee.com/',
				listing: 'https://yelp.com/biz/blue-bottle-coffee-sf'
			}
		]);
	});

	it('falls back to a named location without coordinates', async () => {
		const fetchImpl = mockFetch({ body: { results: [] } });
		await searchPlaces('k', { location: 'lisbon portugal', limit: 3 }, asFetch(fetchImpl));
		const url = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(url.searchParams.get('location')).toBe('lisbon portugal');
		expect(url.searchParams.has('q')).toBe(false);
	});
});

describe('searchPerplexity', () => {
	it('posts the query and maps results to source cards', async () => {
		const fetchImpl = mockFetch({
			body: {
				id: 'x',
				results: [
					{
						title: 'Perplexity result',
						url: 'https://p.example/a',
						snippet: 'A snippet',
						date: '2025-01-23',
						last_updated: '2025-09-25'
					}
				]
			}
		});
		const results = await searchPerplexity(
			'pplx-key',
			'q',
			{ limit: 30, timeRange: 'month' },
			asFetch(fetchImpl)
		);
		const [input, init] = fetchImpl.mock.calls[0];
		expect(String(input)).toBe(PERPLEXITY_ENDPOINT);
		expect(init?.method).toBe('POST');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer pplx-key');
		expect(JSON.parse(String(init?.body))).toEqual({
			query: 'q',
			max_results: 20,
			search_recency_filter: 'month'
		});
		expect(results).toEqual([
			{
				card: {
					url: 'https://p.example/a',
					title: 'Perplexity result',
					site: 'p.example',
					description: 'A snippet',
					favicon: 'https://p.example/favicon.ico'
				},
				published: '2025-01-23'
			}
		]);
	});

	it('flags a rejected key and reports validation errors', async () => {
		const rejected = await searchPerplexity(
			'bad',
			'q',
			{ limit: 1 },
			asFetch(mockFetch({ status: 401, body: {} }))
		).catch((e: unknown) => e);
		expect((rejected as WebSearchError).rejected).toBe(true);
		await expect(
			searchPerplexity(
				'k',
				'q',
				{ limit: 1 },
				asFetch(mockFetch({ status: 422, body: { detail: [{ msg: 'query too long' }] } }))
			)
		).rejects.toThrow(/422: query too long/);
	});
});

describe('cancellation', () => {
	/** Never answers, and rejects once its signal aborts, like the real fetch. */
	function hangingFetch() {
		return vi.fn(
			(_input: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
				})
		);
	}

	const searches: [string, (signal: AbortSignal, fetchImpl: FetchImpl) => Promise<unknown>][] = [
		['SearXNG', (signal, f) => searchSearxng('http://s', 'q', { limit: 1, signal }, f)],
		['Brave', (signal, f) => searchBrave('k', 'q', { limit: 1, signal }, f)],
		['Brave news', (signal, f) => searchBrave('k', 'q', { limit: 1, type: 'news', signal }, f)],
		['Brave places', (signal, f) => searchPlaces('k', { location: 'x', limit: 1, signal }, f)],
		['Perplexity', (signal, f) => searchPerplexity('k', 'q', { limit: 1, signal }, f)]
	];

	it.each(searches)('passes the caller abort through from %s', async (_name, search) => {
		const controller = new AbortController();
		const reason = new Error('turn stopped');
		const fetchImpl = hangingFetch();
		const pending = search(controller.signal, fetchImpl as unknown as FetchImpl);
		controller.abort(reason);
		// The abort itself, not a provider error such as "unreachable".
		await expect(pending).rejects.toBe(reason);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
