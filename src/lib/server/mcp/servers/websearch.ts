import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { PROVIDER_NAMES, type ProviderId, type SearchType } from '../../websearch/providers.js';
import {
	canSearch,
	getSearchMode,
	isPlaceSearchConfigured,
	searchOrder,
	searchPlaces,
	webSearch,
	type WebSearchOutcome
} from '../../websearch/service.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';
import { rememberSource } from './webfetch.js';

const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const MAX_PLACES = 20;
const DEFAULT_PLACES = 8;

const names = (ids: ProviderId[]) => ids.map((id) => PROVIDER_NAMES[id]);

/**
 * The header: who answered, then in parentheses who didn't and why. Fallback keeps its
 * original wording ("via X (fallback; …)"); Combined names every provider that answered.
 */
function header(outcome: WebSearchOutcome): string {
	const answered = outcome.providers.filter((p) => p.status === 'ok');
	const errors = outcome.providers.flatMap((p) => (p.error ? [p.error] : []));
	if (outcome.mode === 'fallback') {
		return `via ${names(answered.map((p) => p.id)).join(' + ')}${
			errors.length ? ` (fallback; ${errors.join('; ')})` : ''
		}`;
	}
	const note = [...(answered.some((p) => p.backup) ? ['backup'] : []), ...errors].join('; ');
	return `via ${names(answered.map((p) => p.id)).join(' + ')}${note ? ` (${note})` : ''}`;
}

/**
 * Whether a result links somewhere fetchable: an http(s) URL on a dotted host.
 * Some engines hand back their own redirect links (`http://go/v1/…`) instead.
 */
export function isWebResultUrl(url: string): boolean {
	if (!URL.canParse(url)) return false;
	const u = new URL(url);
	return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
}

/**
 * Two lines per result: title, site and URL, then the snippet with which providers
 * found it and when it was published. Favicons and preview images stay out: they
 * only matter to the ```links widget, which gets the full cards separately.
 * `via` is left out when one provider found every result, since it would only
 * repeat the header.
 */
export function formatResults(query: string, outcome: WebSearchOutcome): string {
	if (outcome.results.length === 0) return `No results for "${query}" ${header(outcome)}.`;
	const contributors = new Set(outcome.results.flatMap((r) => r.via));
	const showVia = contributors.size > 1;
	const lines = outcome.results.map((r, i) => {
		const { url, title, site, description } = r.card;
		const notes = [
			...(showVia ? [`via ${names(r.via).join(', ')}`] : []),
			...(r.published ? [`published ${r.published}`] : [])
		];
		const snippet = [description, notes.length ? `(${notes.join(' · ')})` : '']
			.filter(Boolean)
			.join(' ');
		const heading = `[${i + 1}] ${title}${site && !title.includes(site) ? ` — ${site}` : ''}\n${url}`;
		return snippet ? `${heading}\n${snippet}` : heading;
	});
	return [`Results for "${query}" ${header(outcome)}:`, ...lines].join('\n\n');
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Built per turn from Settings → Services: a tool no configured provider can serve is
 * disabled (left out of the tool list, calls refused), and web_search only offers news
 * when a provider can search it. The registry also skips the whole server while no
 * provider is configured, so models never see it then.
 */
export function createWebsearchServer(ctx?: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-websearch', version: '0.2.0' });
	const db = getDb();
	const news = canSearch(db, 'news');
	// Results from several engines get `via` notes; say what they mean only when they can appear.
	const combining = getSearchMode(db) === 'combined' && searchOrder(db).combined.length > 1;

	const webSearchTool = server.registerTool(
		'web_search',
		{
			description:
				(news ? 'Search the web, or recent news with type "news". ' : 'Search the web. ') +
				'Each result has a title, site, URL and snippet. ' +
				(combining
					? 'Results are merged from several search engines; "via" names the ones that found each result. '
					: '') +
				'Use fetch to read a result in full before relying on details. ' +
				'To cite results, cite inline as [1], [2]… and end your answer with a ' +
				'```links block of {"links":[{"url":"…"}, …]} (the results’ URLs, in citation order).',
			inputSchema: {
				query: z.string().trim().min(1),
				...(news && {
					type: z
						.enum(['web', 'news'])
						.optional()
						.describe('"news" for news articles; default "web"')
				}),
				limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
				time_range: z
					.enum(['day', 'week', 'month', 'year'])
					.optional()
					.describe('Only results from the past day, week, month or year')
			}
		},
		async ({ query, limit, time_range, ...rest }, extra) => {
			const type = 'type' in rest ? (rest.type as SearchType | undefined) : undefined;
			try {
				const found = await webSearch(getDb(), query, {
					limit: limit ?? DEFAULT_RESULTS,
					timeRange: time_range,
					type,
					signal: extra.signal
				});
				const outcome = {
					...found,
					results: found.results.filter((r) => isWebResultUrl(r.card.url))
				};
				// Lets the user's ```links cards show these sites' favicons (/api/favicon).
				if (ctx) for (const r of outcome.results) rememberSource(ctx.userId, r.card);
				// The cards are for the chat's ```links widget only: the model gets `content`.
				return {
					...text(formatResults(query, outcome)),
					structuredContent: { sources: outcome.results.map((r) => r.card) }
				};
			} catch (e) {
				// A cancelled call gets no answer; let the MCP layer handle it as such.
				if (extra.signal.aborted) throw e;
				return err(`web search failed: ${message(e)}`);
			}
		}
	);

	if (!canSearch(db, 'web')) webSearchTool.disable();

	const placesTool = server.registerTool(
		'search_places',
		{
			description:
				'Find places (restaurants, shops, sights, services…) near a location: name, address, ' +
				"rating, price, phone, today's opening hours, coordinates and website. Give a location " +
				'name or coordinates; leave out query to list popular places there.',
			inputSchema: {
				query: z.string().trim().min(1).optional().describe('What to look for, e.g. "coffee"'),
				location: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe('City and country, e.g. "lisbon portugal" or "austin tx united states"'),
				latitude: z.number().min(-90).max(90).optional(),
				longitude: z.number().min(-180).max(180).optional(),
				radius_m: z
					.number()
					.positive()
					.optional()
					.describe('Search radius in meters around the coordinates'),
				limit: z.number().int().min(1).max(MAX_PLACES).optional()
			}
		},
		async ({ query, location, latitude, longitude, radius_m, limit }, extra) => {
			const hasCoords = latitude !== undefined && longitude !== undefined;
			if (!hasCoords && !location) {
				return err('give a location or both latitude and longitude');
			}
			try {
				const places = await searchPlaces(getDb(), {
					query,
					location,
					latitude,
					longitude,
					radius: radius_m,
					limit: limit ?? DEFAULT_PLACES,
					signal: extra.signal
				});
				if (places.length === 0) return text('No places found.');
				return text(places.map((p, i) => `[${i + 1}] ${JSON.stringify(p)}`).join('\n'));
			} catch (e) {
				if (extra.signal.aborted) throw e;
				return err(`place search failed: ${message(e)}`);
			}
		}
	);
	if (!isPlaceSearchConfigured(db)) placesTool.disable();

	return server;
}
