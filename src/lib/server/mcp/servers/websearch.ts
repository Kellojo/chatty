import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { getSetting } from '../../db/repo/settings.js';
import { err, text } from './shared.js';

const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 300;
const MAX_TOTAL_CHARS = 4096;

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	published?: string;
}

interface SearchOptions {
	limit: number;
	categories?: string[];
	engines?: string[];
	time_range?: 'day' | 'week' | 'month' | 'year';
}

interface SearchProvider {
	search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}

interface WebsearchConfig {
	provider: string;
	baseUrl: string;
	defaultLimit: number;
	timeoutMs: number;
	safeSearch: 0 | 1 | 2;
	language: string;
}

function readConfig(): WebsearchConfig {
	const db = getDb();
	const provider = getSetting<string>(db, 'websearch.provider') ?? 'searxng';
	const baseUrl = (getSetting<string>(db, 'websearch.searxng.base_url') ?? '').replace(/\/+$/, '');
	const defaultLimit = clampInt(
		getSetting<number>(db, 'websearch.default_limit'),
		1,
		MAX_RESULTS,
		5
	);
	const timeoutMs = clampInt(getSetting<number>(db, 'websearch.timeout_ms'), 1000, 60000, 15000);
	const safeSearchRaw = getSetting<number>(db, 'websearch.safe_search');
	const safeSearch = (safeSearchRaw === 0 || safeSearchRaw === 2 ? safeSearchRaw : 1) as 0 | 1 | 2;
	const language = getSetting<string>(db, 'websearch.language') ?? 'auto';
	return { provider, baseUrl, defaultLimit, timeoutMs, safeSearch, language };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(v)));
}

function searxngProvider(cfg: WebsearchConfig): SearchProvider {
	return {
		async search(query, opts) {
			const params = new URLSearchParams({ q: query, format: 'json' });
			if (opts.categories?.length) params.set('categories', opts.categories.join(','));
			if (opts.engines?.length) params.set('engines', opts.engines.join(','));
			if (opts.time_range) params.set('time_range', opts.time_range);
			params.set('safesearch', String(cfg.safeSearch));
			if (cfg.language && cfg.language !== 'auto') params.set('language', cfg.language);

			const url = `${cfg.baseUrl}/search?${params.toString()}`;
			const res = await fetch(url, {
				headers: { 'user-agent': 'ai-chat/0.1 (+https://localhost)' },
				signal: AbortSignal.timeout(cfg.timeoutMs)
			});
			if (!res.ok) throw new Error(`searxng returned HTTP ${res.status}`);
			const raw = await res.text();
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(raw);
			} catch {
				throw new Error(`searxng returned non-JSON response`);
			}
			const results = Array.isArray(data.results)
				? (data.results as Record<string, unknown>[])
				: [];
			const items = results
				.filter((r) => r.url && r.title)
				.slice(0, opts.limit)
				.map((r) => ({
					title: String(r.title),
					url: String(r.url),
					snippet: String(r.content ?? '').slice(0, MAX_SNIPPET_CHARS),
					published: typeof r.publishedDate === 'string' ? r.publishedDate : undefined
				}));
			if (items.length === 0 && results.length > 0) {
				const first = results[0];
				const keys = Object.keys(first).join(', ');
				throw new Error(
					`searxng returned ${results.length} results but none had url+title fields. First result keys: ${keys}`
				);
			}
			return items;
		}
	};
}

function getProvider(cfg: WebsearchConfig): SearchProvider | null {
	if (cfg.provider === 'searxng') {
		if (!cfg.baseUrl) return null;
		return searxngProvider(cfg);
	}
	return null;
}

function formatResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) return `No results for "${query}".`;
	let out = '';
	results.forEach((r, i) => {
		let entry = `${i + 1}. [${r.title}](${r.url})`;
		if (r.snippet) entry += `\n   ${r.snippet}`;
		if (r.published) entry += `\n   (published ${r.published})`;
		if (out.length + entry.length > MAX_TOTAL_CHARS) return;
		out += (out ? '\n\n' : '') + entry;
	});
	return out;
}

export function createWebsearchServer(): McpServer {
	const server = new McpServer({ name: 'ai-chat-websearch', version: '0.1.0' });

	server.registerTool(
		'web_search',
		{
			description:
				'Search the web using the configured search provider (SearXNG). Returns a list of results with title, URL, and snippet.',
			inputSchema: {
				query: z.string(),
				limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
				categories: z.array(z.string()).optional(),
				engines: z.array(z.string()).optional(),
				time_range: z.enum(['day', 'week', 'month', 'year']).optional()
			}
		},
		async ({ query, limit, categories, engines, time_range }) => {
			const cfg = readConfig();
			const provider = getProvider(cfg);
			if (!provider) {
				return err(
					'websearch not configured — ask an admin to set the SearXNG URL in Settings → Search'
				);
			}
			try {
				const results = await provider.search(query, {
					limit: limit ?? cfg.defaultLimit,
					categories,
					engines,
					time_range
				});
				return text(formatResults(query, results));
			} catch (e) {
				return err(`web search failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	);

	return server;
}
