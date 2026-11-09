import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readBodyLimited } from '../../net/readBody.js';
import { safeFetch } from '../../net/safeFetch.js';
import { err, text } from './shared.js';

const MAX_BYTES = 1024 * 1024;
/** Only the start of a page is searched for <head> metadata. */
const MAX_HEAD_BYTES = 256 * 1024;

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '')
		.replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|tr|section|article)>|<br\s*\/?>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** A page's source card: one entry of a ```links fence's `links` array. */
export type PageMeta = {
	url: string;
	title: string;
	site?: string;
	description?: string;
	favicon?: string;
	image?: string;
};

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	middot: '·',
	rsquo: '’',
	lsquo: '‘',
	rdquo: '”',
	ldquo: '“'
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity.startsWith('#')) {
			const hex = entity[1] === 'x' || entity[1] === 'X';
			const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

/** Collapse whitespace, decode entities and cap the length on a word boundary. */
function clean(raw: string | undefined, max: number): string | undefined {
	if (!raw) return undefined;
	const s = decodeEntities(raw).replace(/\s+/g, ' ').trim();
	if (!s) return undefined;
	if (s.length <= max) return s;
	const cut = s.slice(0, max);
	const space = cut.lastIndexOf(' ');
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** Attributes of one start tag: lower-cased names, entity-decoded values. */
function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
		const name = m[1].toLowerCase();
		if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
	}
	return out;
}

/** `href` resolved against `base`, kept only when it is http(s). */
function absolute(href: string | undefined, base: string): string | undefined {
	if (!href?.trim()) return undefined;
	try {
		const u = new URL(href.trim(), base);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
	} catch {
		return undefined;
	}
}

/** The page's own icon: an SVG, else the declared size closest to 32px, else /favicon.ico. */
function pickFavicon(links: Record<string, string>[], base: string): string | undefined {
	let best: { href: string; score: number } | undefined;
	for (const link of links) {
		const rel = (link.rel ?? '').toLowerCase().split(/\s+/);
		if (!rel.includes('icon')) continue; // also skips mask-icon / apple-touch-icon
		const href = absolute(link.href, base);
		if (!href) continue;
		const size = Number(/(\d+)x\d+/i.exec(link.sizes ?? '')?.[1]);
		const svg = /svg/i.test(link.type ?? '') || /\.svg(?:[?#]|$)/i.test(href);
		const score = svg ? 0 : size ? Math.abs(size - 32) + (size < 32 ? 16 : 0) : 20;
		if (!best || score < best.score) best = { href, score };
	}
	return best?.href ?? absolute('/favicon.ico', base);
}

/**
 * Card metadata from a page's <head>: title, site name, description, favicon
 * and preview image, with URLs resolved absolute. Missing fields are omitted.
 */
export function extractPageMeta(html: string, pageUrl: string): PageMeta {
	const headEnd = /<\/head\s*>|<body\b/i.exec(html.slice(0, MAX_HEAD_BYTES))?.index;
	const head = html.slice(0, headEnd ?? MAX_HEAD_BYTES);
	const meta: Record<string, string> = {};
	for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
		const a = attrs(m[0]);
		const key = (a.property ?? a.name ?? '').toLowerCase();
		if (key && a.content?.trim() && !(key in meta)) meta[key] = a.content;
	}
	const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
	const baseTag = /<base\b[^>]*>/i.exec(head)?.[0];
	const base = (baseTag && absolute(attrs(baseTag).href, pageUrl)) || pageUrl;
	const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
	const host = URL.canParse(pageUrl) ? new URL(pageUrl).hostname.replace(/^www\./, '') : '';
	const card: PageMeta = {
		url: pageUrl,
		title: clean(meta['og:title'] ?? meta['twitter:title'] ?? titleTag, 160) ?? (host || pageUrl),
		site: clean(meta['og:site_name'] ?? meta['application-name'], 60),
		description: clean(
			meta['og:description'] ?? meta['description'] ?? meta['twitter:description'],
			200
		),
		favicon: pickFavicon(links, base),
		image: absolute(meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'], base)
	};
	return Object.fromEntries(
		Object.entries(card).filter(([, v]) => v !== undefined)
	) as unknown as PageMeta;
}

export function createWebfetchServer(): McpServer {
	const server = new McpServer({ name: 'ai-chat-webfetch', version: '0.1.0' });
	server.registerTool(
		'fetch',
		{
			description:
				'Fetch a URL and return its body. format=html returns raw HTML; text/markdown strip markup from HTML pages. ' +
				'HTML pages also return a JSON source card; to cite pages you fetched, end your answer with a ' +
				'```links fenced code block containing {"links":[card, …]} (cards verbatim) and cite them inline as [1], [2] in that order.',
			inputSchema: {
				url: z.string(),
				format: z.enum(['markdown', 'text', 'html']).optional()
			}
		},
		async ({ url, format }) => {
			const fmt = format ?? 'markdown';
			let res: Response;
			try {
				res = await safeFetch(url, {
					headers: { 'user-agent': 'ai-chat/0.1 (+https://localhost)' },
					signal: AbortSignal.timeout(15000)
				});
			} catch (e) {
				return err(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (!res.ok) return err(`fetch failed with status ${res.status}`);
			let limited;
			try {
				limited = await readBodyLimited(res, MAX_BYTES);
			} catch (e) {
				return err(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			const body = limited.body.toString('utf-8');
			const suffix = limited.truncated ? '\n… truncated' : '';
			const contentType = res.headers.get('content-type') ?? '';
			if (!/text\/html|application\/xhtml/i.test(contentType)) return text(body + suffix);
			const result = text(fmt === 'html' ? body + suffix : htmlToText(body) + suffix);
			// The body stays the first content part; the card is an extra part.
			const card = extractPageMeta(body, res.url || url);
			result.content.push({ type: 'text', text: `Source card: ${JSON.stringify(card)}` });
			return result;
		}
	);
	return server;
}
