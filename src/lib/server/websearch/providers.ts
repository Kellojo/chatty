import { clean, type PageMeta } from '../mcp/servers/webfetch.js';
import { readBodyLimited } from '../net/readBody.js';
import { linkLocalGuardedAgent } from '../net/safeFetch.js';

export type ProviderId = 'searxng' | 'brave' | 'perplexity';
/** `news` limits results to news articles; not every provider has it. */
export type SearchType = 'web' | 'news';
export type TimeRange = 'day' | 'week' | 'month' | 'year';

export const PROVIDER_NAMES: Record<ProviderId, string> = {
	searxng: 'SearXNG',
	brave: 'Brave Search',
	perplexity: 'Perplexity'
};

/** Search types each provider can run; the others skip it for that search. */
export const PROVIDER_TYPES: Record<ProviderId, readonly SearchType[]> = {
	searxng: ['web', 'news'],
	brave: ['web', 'news'],
	perplexity: ['web']
};

export interface SearchOptions {
	limit: number;
	timeRange?: TimeRange;
	type?: SearchType;
	/** The caller's signal, e.g. the tool call's; aborting it cancels the request. */
	signal?: AbortSignal;
}

export interface SearchResult {
	/** The same source card `fetch` returns, so citations look alike. */
	card: PageMeta;
	published?: string;
}

export type FetchImpl = typeof fetch;

export class WebSearchError extends Error {
	constructor(
		message: string,
		readonly provider: ProviderId,
		/** The provider turned the API key down. */
		readonly rejected = false
	) {
		super(message);
		this.name = 'WebSearchError';
	}
}

const USER_AGENT = 'ai-chat/0.1 (+https://localhost)';
const TIMEOUT_MS = 15_000;

/** A request's signal: the provider timeout, plus the caller's signal when there is one. */
function requestSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Runs a request, passing the caller's abort through as-is: a cancelled search isn't a
 * provider error, so it must not be reported as "unreachable" or tried elsewhere.
 */
async function cancellable<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (signal?.aborted) throw signal.reason;
		throw e;
	}
}
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '');

function httpUrl(raw: unknown, base?: string): string | undefined {
	if (typeof raw !== 'string' || !raw.trim()) return undefined;
	try {
		const u = new URL(raw.trim(), base);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
	} catch {
		return undefined;
	}
}

/** A source card for one result; fields the provider doesn't give are left out. */
function toCard(r: {
	url: string;
	title: unknown;
	snippet?: unknown;
	site?: unknown;
	favicon?: unknown;
	image?: unknown;
}): PageMeta {
	const host = new URL(r.url).hostname.replace(/^www\./, '');
	const card: PageMeta = {
		url: r.url,
		title: clean(stripTags(String(r.title ?? '')), 160) ?? host,
		site: clean(typeof r.site === 'string' ? r.site : host, 60),
		description: clean(typeof r.snippet === 'string' ? stripTags(r.snippet) : undefined, 200),
		// Like fetch's fallback when a page declares no icon.
		favicon: httpUrl(r.favicon) ?? httpUrl('/favicon.ico', r.url),
		image: httpUrl(r.image)
	};
	return Object.fromEntries(
		Object.entries(card).filter(([, v]) => v !== undefined)
	) as unknown as PageMeta;
}

function networkMessage(e: unknown): string {
	if (e instanceof Error && e.name === 'TimeoutError') return 'timed out';
	const cause = (e as { cause?: unknown })?.cause;
	const reason =
		cause instanceof Error ? cause.message : e instanceof Error ? e.message : String(e);
	return reason || 'request failed';
}

async function readJson(res: Response): Promise<unknown> {
	const { body } = await readBodyLimited(res, MAX_BODY_BYTES);
	return JSON.parse(body.toString('utf-8'));
}

// ── SearXNG ──────────────────────────────────────────────────────────────────

const JSON_HINT = 'add "json" to search.formats in its settings.yml';

/**
 * The admin's base URL, cleaned up: http(s) only, no query or fragment, and a pasted
 * `/search` endpoint is cut back to the instance root. Throws on anything else.
 */
export function normalizeSearxngUrl(raw: string): string {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		throw new Error('Enter a full URL, like http://searxng:8080');
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		throw new Error('The URL must start with http:// or https://');
	}
	u.search = '';
	u.hash = '';
	const path = u.pathname.replace(/\/+$/, '').replace(/\/search$/, '');
	return `${u.origin}${path}`;
}

type SearxngResponse = {
	results: Array<Record<string, unknown>>;
	unresponsive_engines?: unknown;
};

/**
 * Queries the JSON API. The instance is configured by the admin and usually on a
 * private network, so this skips fetch's SSRF guard: only link-local and other
 * never-valid addresses (cloud metadata) are refused.
 */
async function querySearxng(
	baseUrl: string,
	query: string,
	opts: Partial<SearchOptions>,
	fetchImpl: FetchImpl
): Promise<SearxngResponse> {
	const params = new URLSearchParams({ q: query, format: 'json' });
	if (opts.timeRange) params.set('time_range', opts.timeRange);
	if (opts.type === 'news') params.set('categories', 'news');
	let res: Response;
	try {
		res = await fetchImpl(`${baseUrl}/search?${params}`, {
			headers: { accept: 'application/json', 'user-agent': USER_AGENT },
			signal: requestSignal(opts.signal),
			dispatcher: linkLocalGuardedAgent
		} as RequestInit);
	} catch (e) {
		throw new WebSearchError(
			`SearXNG is unreachable at ${baseUrl} (${networkMessage(e)})`,
			'searxng'
		);
	}
	if (res.status === 403) {
		await res.body?.cancel().catch(() => {});
		throw new WebSearchError(`SearXNG refused JSON output (HTTP 403); ${JSON_HINT}`, 'searxng');
	}
	if (res.status === 429) {
		await res.body?.cancel().catch(() => {});
		throw new WebSearchError(
			"SearXNG's bot limiter blocked the request (HTTP 429); turn off server.limiter or allow Chatty's address",
			'searxng'
		);
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new WebSearchError(`SearXNG returned HTTP ${res.status}`, 'searxng');
	}
	let data: unknown;
	try {
		data = await readJson(res);
	} catch {
		throw new WebSearchError(
			`SearXNG answered with something other than JSON; check the URL points at SearXNG and ${JSON_HINT}`,
			'searxng'
		);
	}
	const results = (data as { results?: unknown })?.results;
	if (!Array.isArray(results)) {
		throw new WebSearchError(
			'SearXNG returned an unexpected response (no results list)',
			'searxng'
		);
	}
	return data as SearxngResponse;
}

/** Runs a test query; throws a `WebSearchError` saying what's wrong with the instance. */
export async function verifySearxng(baseUrl: string, fetchImpl: FetchImpl = fetch): Promise<void> {
	await querySearxng(baseUrl, 'chatty', {}, fetchImpl);
}

export async function searchSearxng(
	baseUrl: string,
	query: string,
	opts: SearchOptions,
	fetchImpl: FetchImpl = fetch
): Promise<SearchResult[]> {
	const data = await cancellable(opts.signal, () => querySearxng(baseUrl, query, opts, fetchImpl));
	const results = data.results
		.map((r) => ({ r, url: httpUrl(r.url) }))
		.filter((x): x is { r: Record<string, unknown>; url: string } => !!x.url && !!x.r.title)
		.slice(0, opts.limit)
		.map(({ r, url }) => ({
			card: toCard({
				url,
				title: r.title,
				snippet: r.content,
				image: r.thumbnail ?? r.img_src
			}),
			published: typeof r.publishedDate === 'string' ? r.publishedDate : undefined
		}));
	// No results because every engine failed is an outage, not an empty answer.
	const failed = Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [];
	if (results.length === 0 && failed.length > 0) {
		const engines = failed
			.map((e) => (Array.isArray(e) ? `${e[0]} (${e[1]})` : String(e)))
			.join(', ');
		throw new WebSearchError(`SearXNG engines failed: ${engines}`, 'searxng');
	}
	return results;
}

// ── Brave Search ─────────────────────────────────────────────────────────────

export const BRAVE_API = 'https://api.search.brave.com/res/v1';
/** Brave's own limits for `count`. */
const BRAVE_MAX_WEB = 20;
const BRAVE_MAX_NEWS = 50;
const FRESHNESS: Record<TimeRange, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) ? v : undefined;

async function braveErrorDetail(res: Response): Promise<{ code: string; detail: string }> {
	try {
		const body = obj(obj(await readJson(res)).error);
		return { code: String(body.code ?? ''), detail: String(body.detail ?? '') };
	} catch {
		return { code: '', detail: '' };
	}
}

/** One GET against the Brave Search API, with its errors turned into readable messages. */
async function braveGet(
	apiKey: string,
	path: string,
	params: URLSearchParams,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl
): Promise<Json> {
	let res: Response;
	try {
		res = await fetchImpl(`${BRAVE_API}${path}?${params}`, {
			headers: {
				accept: 'application/json',
				'user-agent': USER_AGENT,
				'x-subscription-token': apiKey
			},
			signal: requestSignal(signal)
		});
	} catch (e) {
		throw new WebSearchError(`Brave Search is unreachable (${networkMessage(e)})`, 'brave');
	}
	if (!res.ok) {
		const { code, detail } = await braveErrorDetail(res);
		if (res.status === 401 || res.status === 403 || /TOKEN|AUTH/i.test(code)) {
			throw new WebSearchError('Brave Search rejected the API key', 'brave', true);
		}
		if (res.status === 429) throw new WebSearchError('Brave Search rate limit reached', 'brave');
		throw new WebSearchError(
			`Brave Search request failed (${res.status}${detail ? `: ${detail}` : ''})`,
			'brave'
		);
	}
	try {
		return obj(await readJson(res));
	} catch {
		throw new WebSearchError('Brave Search returned an unexpected response', 'brave');
	}
}

/** Web results sit under `web.results`, news results at the top level. */
export async function searchBrave(
	apiKey: string,
	query: string,
	opts: SearchOptions,
	fetchImpl: FetchImpl = fetch
): Promise<SearchResult[]> {
	const news = opts.type === 'news';
	const params = new URLSearchParams({
		q: query,
		count: String(Math.min(opts.limit, news ? BRAVE_MAX_NEWS : BRAVE_MAX_WEB))
	});
	if (!news) params.set('text_decorations', 'false');
	if (opts.timeRange) params.set('freshness', FRESHNESS[opts.timeRange]);
	const path = news ? '/news/search' : '/web/search';
	const data = await cancellable(opts.signal, () =>
		braveGet(apiKey, path, params, opts.signal, fetchImpl)
	);
	const list = news ? data.results : obj(data.web).results;
	const results = Array.isArray(list) ? (list as Json[]) : [];
	return results
		.map((r) => ({ r, url: httpUrl(r.url) }))
		.filter((x): x is { r: Json; url: string } => !!x.url && !!x.r.title)
		.slice(0, opts.limit)
		.map(({ r, url }) => ({
			card: toCard({
				url,
				title: r.title,
				snippet: r.description,
				site: obj(r.profile).name ?? obj(r.meta_url).hostname,
				favicon: obj(r.meta_url).favicon,
				image: obj(r.thumbnail).src
			}),
			published: str(r.page_age) ?? str(r.age)
		}));
}

export interface PlaceQuery {
	query?: string;
	/** A place name, e.g. "lisbon portugal"; used when no coordinates are given. */
	location?: string;
	latitude?: number;
	longitude?: number;
	/** Meters; biases results towards the center rather than cutting them off. */
	radius?: number;
	limit: number;
	/** The caller's signal; aborting it cancels the request. */
	signal?: AbortSignal;
}

/** A place, trimmed to what a model needs to answer with it. */
export interface Place {
	name: string;
	address?: string;
	categories?: string[];
	rating?: string;
	price?: string;
	phone?: string;
	/** Today's opening hours, e.g. "07:00–18:00". */
	hoursToday?: string;
	distance?: string;
	/** [latitude, longitude] */
	coordinates?: [number, number];
	website?: string;
	/** The listing the data comes from (Yelp, TripAdvisor…). */
	listing?: string;
}

function toPlace(r: Json): Place | null {
	const name = str(r.title);
	if (!name) return null;
	const rating = obj(r.rating);
	const ratingValue = num(rating.ratingValue);
	const reviews = num(rating.reviewCount);
	const today = obj(r.opening_hours).current_day;
	const hours = (Array.isArray(today) ? today : [])
		.map((h) => `${str(obj(h).opens) ?? '?'}–${str(obj(h).closes) ?? '?'}`)
		.join(', ');
	const distance = obj(r.distance);
	const [lat, lng] = Array.isArray(r.coordinates) ? r.coordinates : [];
	const categories = Array.isArray(r.categories)
		? r.categories.filter((c): c is string => typeof c === 'string')
		: [];
	const place: Place = {
		name,
		address: str(obj(r.postal_address).displayAddress),
		categories: categories.length ? categories : undefined,
		rating:
			ratingValue !== undefined
				? `${ratingValue}/${num(rating.bestRating) ?? 5}` +
					(reviews !== undefined ? ` (${reviews} reviews)` : '')
				: undefined,
		price: str(r.price_range),
		phone: str(obj(r.contact).telephone),
		hoursToday: hours || undefined,
		distance:
			num(distance.value) !== undefined
				? `${distance.value} ${str(distance.units) ?? ''}`.trim()
				: undefined,
		coordinates:
			num(lat) !== undefined && num(lng) !== undefined ? [lat as number, lng as number] : undefined,
		website: httpUrl(r.url),
		listing: httpUrl(r.provider_url)
	};
	return Object.fromEntries(
		Object.entries(place).filter(([, v]) => v !== undefined)
	) as unknown as Place;
}

/** Brave's Place Search: points of interest around coordinates or a named location. */
export async function searchPlaces(
	apiKey: string,
	q: PlaceQuery,
	fetchImpl: FetchImpl = fetch
): Promise<Place[]> {
	const params = new URLSearchParams({ count: String(q.limit) });
	if (q.query) params.set('q', q.query);
	if (q.latitude !== undefined && q.longitude !== undefined) {
		params.set('latitude', String(q.latitude));
		params.set('longitude', String(q.longitude));
	} else if (q.location) {
		params.set('location', q.location);
	}
	if (q.radius !== undefined) params.set('radius', String(q.radius));
	const data = await cancellable(q.signal, () =>
		braveGet(apiKey, '/local/place_search', params, q.signal, fetchImpl)
	);
	const results = Array.isArray(data.results) ? (data.results as Json[]) : [];
	return results
		.map(toPlace)
		.filter((p): p is Place => p !== null)
		.slice(0, q.limit);
}

// ── Perplexity ───────────────────────────────────────────────────────────────

export const PERPLEXITY_ENDPOINT = 'https://api.perplexity.ai/search';
/** Perplexity's limit for web results. */
const PERPLEXITY_MAX_RESULTS = 20;

async function perplexityErrorDetail(res: Response): Promise<string> {
	try {
		const body = obj(await readJson(res));
		const detail = body.detail ?? obj(body.error).message;
		if (Array.isArray(detail)) return detail.map((d) => str(obj(d).msg) ?? '').join('; ');
		return str(detail) ?? '';
	} catch {
		return '';
	}
}

/** Perplexity's Search API: ranked web results, without an LLM answer. */
export function searchPerplexity(
	apiKey: string,
	query: string,
	opts: SearchOptions,
	fetchImpl: FetchImpl = fetch
): Promise<SearchResult[]> {
	return cancellable(opts.signal, () => perplexityRequest(apiKey, query, opts, fetchImpl));
}

async function perplexityRequest(
	apiKey: string,
	query: string,
	opts: SearchOptions,
	fetchImpl: FetchImpl
): Promise<SearchResult[]> {
	const body: Json = { query, max_results: Math.min(opts.limit, PERPLEXITY_MAX_RESULTS) };
	if (opts.timeRange) body.search_recency_filter = opts.timeRange;
	let res: Response;
	try {
		res = await fetchImpl(PERPLEXITY_ENDPOINT, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				'user-agent': USER_AGENT,
				authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify(body),
			signal: requestSignal(opts.signal)
		});
	} catch (e) {
		throw new WebSearchError(`Perplexity is unreachable (${networkMessage(e)})`, 'perplexity');
	}
	if (!res.ok) {
		const detail = await perplexityErrorDetail(res);
		if (res.status === 401 || res.status === 403) {
			throw new WebSearchError('Perplexity rejected the API key', 'perplexity', true);
		}
		if (res.status === 429) throw new WebSearchError('Perplexity rate limit reached', 'perplexity');
		throw new WebSearchError(
			`Perplexity request failed (${res.status}${detail ? `: ${detail}` : ''})`,
			'perplexity'
		);
	}
	let data: Json;
	try {
		data = obj(await readJson(res));
	} catch {
		throw new WebSearchError('Perplexity returned an unexpected response', 'perplexity');
	}
	const results = Array.isArray(data.results) ? (data.results as Json[]) : [];
	return results
		.map((r) => ({ r, url: httpUrl(r.url) }))
		.filter((x): x is { r: Json; url: string } => !!x.url && !!x.r.title)
		.slice(0, opts.limit)
		.map(({ r, url }) => ({
			card: toCard({ url, title: r.title, snippet: r.snippet }),
			published: str(r.date)
		}));
}
