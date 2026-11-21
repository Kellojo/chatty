import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { rememberSourceSite } from '../../db/repo/source-sites.js';
import { createLogger } from '../../logger.js';
import { readBodyLimited } from '../../net/readBody.js';
import { safeFetch } from '../../net/safeFetch.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const log = createLogger('webfetch');

const MAX_BYTES = 1024 * 1024;
/** Only the start of a page is searched for <head> metadata. */
const MAX_HEAD_BYTES = 256 * 1024;
/**
 * Characters returned per call unless the model asks for more: a whole page
 * would fill a small local model's context in one step. Later chunks come
 * from `start_index`.
 */
const DEFAULT_MAX_CHARS = 8000;
const MAX_CHARS = 50_000;
/** A <main> or lone <article> with less text than this isn't trusted to be the page's content. */
const MIN_MAIN_TEXT = 400;
const MAX_EVENTS = 25;

/**
 * A page's source card. Tools hand cards to the chat in `structuredContent.sources`
 * (which the model never sees); the ```links widget fills cited URLs in from them.
 */
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
	ldquo: '“',
	sbquo: '‚',
	bdquo: '„',
	laquo: '«',
	raquo: '»',
	lsaquo: '‹',
	rsaquo: '›',
	bull: '•',
	copy: '©',
	reg: '®',
	trade: '™',
	euro: '€',
	pound: '£',
	yen: '¥',
	cent: '¢',
	sect: '§',
	para: '¶',
	deg: '°',
	plusmn: '±',
	times: '×',
	divide: '÷',
	minus: '−',
	frac12: '½',
	frac14: '¼',
	frac34: '¾',
	larr: '←',
	rarr: '→',
	uarr: '↑',
	darr: '↓',
	iexcl: '¡',
	iquest: '¿',
	szlig: 'ß',
	shy: '',
	zwj: '',
	zwnj: '',
	ensp: ' ',
	emsp: ' ',
	thinsp: ' '
};

/** Combining marks for accented-letter entities such as `&eacute;` or `&Ouml;`. */
const ACCENTS: Record<string, string> = {
	grave: '̀',
	acute: '́',
	circ: '̂',
	tilde: '̃',
	uml: '̈',
	ring: '̊',
	cedil: '̧'
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
		if (entity.startsWith('#')) {
			const hex = entity[1] === 'x' || entity[1] === 'X';
			const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		const named = NAMED_ENTITIES[entity.toLowerCase()];
		if (named !== undefined) return named;
		const accented = /^([a-z])(grave|acute|circ|tilde|uml|ring|cedil)$/i.exec(entity);
		if (accented) {
			const letter = `${accented[1]}${ACCENTS[accented[2].toLowerCase()]}`.normalize('NFC');
			if (letter.length === 1) return letter;
		}
		return match;
	});
}

/** Tags whose content is never page text. */
const NOISE = /<(script|style|noscript|template|svg|nav|head|iframe)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK =
	/<\/?(?:p|div|section|article|main|header|footer|aside|blockquote|figure|figcaption|table|thead|tbody|tfoot|tr|form|fieldset|address|details|summary|dl|dt|dd|hr|h[1-6]|ul|ol|li|pre)\b[^>]*>/gi;
const BR = /<br\s*\/?>/gi;

/**
 * Keeps finished snippets (code, URLs, headings, lists) behind private-use-character
 * tokens so later passes — whitespace collapsing, tag stripping, entity
 * decoding — leave them alone. `restore` puts them back, nested tokens included.
 */
class Stash {
	private parts: string[] = [];
	put(s: string): string {
		this.parts.push(s);
		return `\uE000${this.parts.length - 1}\uE000`;
	}
	restore(s: string): string {
		return s.replace(/\uE000(\d+)\uE000/g, (_, i: string) => this.restore(this.parts[Number(i)]));
	}
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '');

/** Inline content as one line of decoded text. */
const inline = (html: string) => decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();

/** Body with noise and comments dropped, `<pre>` blocks stashed and source whitespace collapsed. */
function prepare(html: string, stash: Stash, fence: boolean): string {
	return (
		html
			.replace(/[\uE000\uE001]/g, '')
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(NOISE, '')
			.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi, (_, attrsRaw: string, inner: string) => {
				const code = decodeEntities(stripTags(inner.replace(BR, '\n'))).replace(/^\n+|\s+$/g, '');
				if (!fence) return `\n\n${stash.put(code)}\n\n`;
				const lang = /lang(?:uage)?-([\w+#-]+)/i.exec(`${attrsRaw} ${inner.slice(0, 200)}`)?.[1];
				const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
				const ticks = '`'.repeat(Math.max(3, longest + 1));
				return `\n\n${stash.put(`${ticks}${lang ?? ''}\n${code}\n${ticks}`)}\n\n`;
			})
			// HTML collapses source whitespace; line breaks come from the markup alone.
			.replace(/\s+/g, ' ')
	);
}

/** Final pass of both formats: strip leftover tags, decode entities, tidy blank lines. */
function finish(s: string, stash: Stash): string {
	const body = decodeEntities(stripTags(s))
		.split('\n')
		.map((line) => line.replace(/[ \t]+/g, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return stash.restore(body);
}

function htmlToText(html: string): string {
	const stash = new Stash();
	const s = prepare(html, stash, false)
		.replace(BR, '\n')
		.replace(/<\/(?:td|th)\s*>/gi, '\t')
		.replace(BLOCK, '\n');
	return finish(s, stash);
}

/** Converts innermost lists first, so a parent item can indent the lists nested in it. */
function convertLists(html: string, stash: Stash): string {
	const innermost = /<(ul|ol)\b[^>]*>((?:(?!<(?:ul|ol)\b)[\s\S])*?)<\/\1\s*>/i;
	const listToken = /\uE001(\d+)\uE001/g;
	const lists: string[] = [];
	let s = html;
	for (let m = innermost.exec(s); m; m = innermost.exec(s)) {
		const ordered = m[1].toLowerCase() === 'ol';
		const items = m[2].split(/<li\b[^>]*>/i).slice(1);
		const lines = items.map((item, i) => {
			const marker = ordered ? `${i + 1}.` : '-';
			const pad = ' '.repeat(marker.length + 1);
			const nested = [...item.matchAll(listToken)].map((t) =>
				lists[Number(t[1])].replace(/^/gm, pad)
			);
			const own = inline(item.replace(listToken, ' ').replace(BR, ' '));
			return [`${marker} ${own}`, ...nested].join('\n');
		});
		lists.push(lines.join('\n'));
		s = `${s.slice(0, m.index)}\uE001${lists.length - 1}\uE001${s.slice(m.index + m[0].length)}`;
	}
	// Top-level lists become stashed blocks; their text is already decoded.
	return s.replace(listToken, (_, i: string) => `\n\n${stash.put(lists[Number(i)])}\n\n`);
}

/** HTML → markdown: headings, links, images, lists, emphasis, quotes, code and paragraphs. */
function htmlToMarkdown(html: string, pageUrl: string): string {
	const stash = new Stash();
	const emphasis = (mark: string) => (match: string, _tag: string, inner: string) =>
		stripTags(inner).trim() ? `${mark}${inner.trim()}${mark}` : inner;
	const block = (md: string) => (md ? `\n\n${stash.put(md)}\n\n` : '');
	let s = prepare(html, stash, true)
		.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner: string) => {
			const code = inline(inner);
			if (!code) return '';
			return stash.put(code.includes('`') ? `\`\` ${code} \`\`` : `\`${code}\``);
		})
		.replace(/<img\b[^>]*>/gi, (tag) => {
			const a = attrs(tag);
			const src = absolute(a.src, pageUrl);
			return src ? stash.put(`![${(a.alt ?? '').replace(/[[\]]/g, '')}](${src})`) : '';
		})
		.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrsRaw: string, inner: string) => {
			const href = absolute(attrs(attrsRaw).href, pageUrl);
			return href && stripTags(inner).trim() ? `[${inner.trim()}](${stash.put(href)})` : inner;
		})
		.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, emphasis('**'))
		.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, emphasis('*'))
		.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => {
			const t = inline(inner);
			return t ? block(`${'#'.repeat(Number(level))} ${t}`) : '';
		})
		.replace(/<hr\b[^>]*>/gi, () => block('---'))
		.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_, inner: string) => {
			const paras = inner
				.split(/<\/?(?:p|div)\b[^>]*>|<br\s*\/?>/i)
				.map(inline)
				.filter(Boolean);
			return block(paras.map((p) => `> ${p}`).join('\n>\n'));
		});
	s = convertLists(s, stash)
		.replace(BR, '\n')
		.replace(/<\/(?:td|th)\s*>/gi, ' | ')
		.replace(BLOCK, '\n\n');
	return finish(s, stash);
}

/** Content types whose bytes are meant to be read as text. */
function isTextType(mime: string): boolean {
	return (
		mime.startsWith('text/') ||
		/[/+](?:json|xml|yaml|x-yaml|javascript|ecmascript|csv|x-ndjson|graphql)$/.test(mime) ||
		mime === 'application/x-www-form-urlencoded' ||
		mime === 'application/x-sh'
	);
}

function binaryError(contentType: string) {
	return err(
		`the response is ${contentType} content, which can't be returned as text. ` +
			'Use fs_curl to download it into the workspace instead.'
	);
}

/** Collapse whitespace, decode entities and cap the length on a word boundary. */
export function clean(raw: string | undefined, max: number): string | undefined {
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

/** How far a declared icon size is from `target`px; smaller icons are penalized (they'd be upscaled). */
export function sizeScore(sizes: string | undefined, target: number): number | null {
	const size = Number(/(\d+)x\d+/i.exec(sizes ?? '')?.[1]);
	return size ? Math.abs(size - target) / target + (size < target ? 0.5 : 0) : null;
}

/** A page's <head>: its first <meta> values by name/property, its <link> tags and its base URL. */
function parseHead(html: string, pageUrl: string) {
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
	return { head, meta, links, base };
}

/**
 * Every icon a page's <head> declares, best first: rel="icon" / "shortcut icon"
 * (SVG, then the size closest to 32px), then apple-touch-icon(-precomposed),
 * then the Windows tile image. mask-icon is skipped: it's a one-colour
 * silhouette. `manifest` is the web app manifest, which may list more icons.
 */
export function pageIcons(html: string, pageUrl: string): { icons: string[]; manifest?: string } {
	const { meta, links, base } = parseHead(html, pageUrl);
	const ranked: { href: string; score: number }[] = [];
	let manifest: string | undefined;
	for (const link of links) {
		const rel = (link.rel ?? '').toLowerCase().split(/\s+/);
		const href = absolute(link.href, base);
		if (!href) continue;
		if (rel.includes('manifest')) {
			manifest ??= href;
		} else if (rel.includes('icon')) {
			const svg = /svg/i.test(link.type ?? '') || /\.svg(?:[?#]|$)/i.test(href);
			ranked.push({ href, score: svg ? 0 : (sizeScore(link.sizes, 32) ?? 0.6) + 0.01 });
		} else if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) {
			// Usually 180px; the legacy -precomposed variant only when nothing else is there.
			const legacy = !rel.includes('apple-touch-icon');
			ranked.push({ href, score: 100 + (sizeScore(link.sizes, 180) ?? 0.3) + (legacy ? 1 : 0) });
		}
	}
	const tile = absolute(meta['msapplication-tileimage'], base);
	if (tile) ranked.push({ href: tile, score: 200 });
	ranked.sort((a, b) => a.score - b.score);
	return { icons: [...new Set(ranked.map((r) => r.href))], manifest };
}

/**
 * Card metadata from a page's <head>: title, site name, description, favicon
 * and preview image, with URLs resolved absolute. Missing fields are omitted.
 */
export function extractPageMeta(html: string, pageUrl: string): PageMeta {
	const { head, meta, base } = parseHead(html, pageUrl);
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
		favicon: pageIcons(html, pageUrl).icons[0] ?? absolute('/favicon.ico', base),
		image: absolute(meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'], base)
	};
	return Object.fromEntries(
		Object.entries(card).filter(([, v]) => v !== undefined)
	) as unknown as PageMeta;
}

type Json = Record<string, unknown>;

const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** The parsed JSON-LD blocks of a page; malformed ones (common in the wild) are skipped. */
function ldJsonBlocks(html: string): unknown[] {
	const blocks: unknown[] = [];
	const script =
		/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
	for (const m of html.matchAll(script)) {
		const raw = m[1].replace(/^\s*(?:<!--|<!\[CDATA\[)|(?:-->|\]\]>)\s*$/g, '').trim();
		try {
			blocks.push(JSON.parse(raw));
		} catch {
			// Not valid JSON: nothing to read.
		}
	}
	return blocks;
}

/** schema.org Event and its subtypes (MusicEvent, SportsEvent, ...), and Festival. */
const isEvent = (node: Json) =>
	list(node['@type']).some(
		(t) => typeof t === 'string' && /(?:Event|Festival)$/.test(t.replace(/^.*[/:]/, ''))
	);

/** Event nodes anywhere in a JSON-LD tree: top level, @graph, item lists, sub-events. */
function collectEvents(node: unknown, out: Json[], depth = 0): void {
	if (depth > 8 || out.length >= 200) return;
	if (Array.isArray(node)) {
		for (const n of node) collectEvents(n, out, depth + 1);
		return;
	}
	if (!isJson(node)) return;
	if (isEvent(node)) out.push(node);
	for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity', 'subEvent', 'event']) {
		if (key in node) collectEvents(node[key], out, depth + 1);
	}
}

const scalar = (v: unknown, max = 120): string | undefined =>
	typeof v === 'number' ? String(v) : typeof v === 'string' ? clean(v, max) : undefined;
const nameOf = (v: unknown): string | undefined => {
	const first = list(v)[0];
	return isJson(first) ? scalar(first.name) : scalar(first);
};
/** "https://schema.org/InStock" → "InStock". */
const enumValue = (v: unknown): string | undefined =>
	typeof v === 'string' && v.trim()
		? v.trim().replace(/^https?:\/\/schema\.org\//i, '')
		: undefined;

/** Venue name and address, e.g. "halle02, Zollhofgarten 2, Heidelberg, DE". */
function placeOf(v: unknown): string | undefined {
	const place = list(v)[0];
	if (!isJson(place)) return scalar(place, 200);
	const a = place.address;
	const address = isJson(a)
		? [scalar(a.streetAddress), scalar(a.addressLocality), nameOf(a.addressCountry)]
		: [scalar(a, 200)];
	const parts = [scalar(place.name), ...address].filter((p): p is string => !!p);
	return parts.length ? [...new Set(parts)].join(', ') : undefined;
}

/** "from 35 EUR, InStock": the first offer's price and availability. */
function offersOf(v: unknown): string | undefined {
	const offers = list(v).filter(isJson);
	const o = offers[0];
	if (!o) return undefined;
	const price = scalar(o.lowPrice ?? o.price);
	const currency = scalar(o.priceCurrency);
	const from = offers.length > 1 || o.lowPrice !== undefined ? 'from ' : '';
	const parts = [
		price !== undefined ? `${from}${price}${currency ? ` ${currency}` : ''}` : undefined,
		enumValue(o.availability)
	].filter(Boolean);
	return parts.length ? parts.join(', ') : undefined;
}

function eventLine(e: Json, pageUrl: string): string | null {
	const name = scalar(e.name, 160);
	const start = scalar(e.startDate);
	if (!name && !start) return null;
	const end = scalar(e.endDate);
	const status = enumValue(e.eventStatus);
	const performers = list(e.performer)
		.map(nameOf)
		.filter((p): p is string => !!p)
		.slice(0, 6);
	const offer = list(e.offers).find(isJson);
	const url =
		absolute(scalar(e.url, 500), pageUrl) ??
		(offer ? absolute(scalar(offer.url, 500), pageUrl) : undefined);
	const fields = [
		start ? (end && end !== start ? `${start} – ${end}` : start) : 'date unknown',
		name,
		placeOf(e.location),
		performers.length ? `with ${performers.join(', ')}` : undefined,
		offersOf(e.offers),
		status && status !== 'EventScheduled' ? status : undefined,
		url
	];
	return `- ${fields.filter(Boolean).join(' · ')}`;
}

/**
 * The events a page declares in schema.org JSON-LD, one line each. Ticket shops,
 * venues and aggregators embed them for search engines, often in the server HTML of
 * pages that otherwise render with JavaScript; a few lines replace pages of markup.
 */
export function structuredEvents(html: string, pageUrl: string): string | null {
	const nodes: Json[] = [];
	for (const block of ldJsonBlocks(html)) collectEvents(block, nodes);
	const lines = [
		...new Set(nodes.map((e) => eventLine(e, pageUrl)).filter((l): l is string => !!l))
	];
	if (lines.length === 0) return null;
	const more = lines.length > MAX_EVENTS ? `\n… and ${lines.length - MAX_EVENTS} more` : '';
	return `Events in this page's structured data (schema.org):\n${lines.slice(0, MAX_EVENTS).join('\n')}${more}`;
}

const textLength = (html: string) =>
	stripTags(html.replace(NOISE, '')).replace(/\s+/g, ' ').trim().length;

/**
 * The page's main content when it marks one (<main>, or a single <article>) with
 * real text in it; otherwise the whole page. Drops site chrome such as headers,
 * menus, footers and "related" rails that pages put outside it.
 */
export function mainContent(html: string): string {
	const main = /<main\b[^>]*>([\s\S]*)<\/main\s*>/i.exec(html)?.[1];
	if (main && textLength(main) >= MIN_MAIN_TEXT) return main;
	const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)];
	if (articles.length === 1 && textLength(articles[0][1]) >= MIN_MAIN_TEXT) return articles[0][1];
	return html;
}

/**
 * One window of a long text, cut at a line break near its end when there is one,
 * with a note on where the next window starts.
 */
export function textWindow(
	text: string,
	start: number,
	max: number
): { text: string; end: number } {
	if (start > 0 && start >= text.length) {
		return {
			text: `[start_index ${start} is past the end of this page (${text.length} chars)]`,
			end: text.length
		};
	}
	let end = Math.min(text.length, start + max);
	if (end < text.length) {
		const lineBreak = text.lastIndexOf('\n', end);
		if (lineBreak > start + max * 0.8) end = lineBreak;
	}
	const head = start > 0 ? `[… continuing from char ${start}]\n\n` : '';
	const tail =
		end < text.length
			? `\n\n… [chars ${start}–${end} of ${text.length} shown; call fetch again with start_index=${end} for more]`
			: '';
	return { text: `${head}${text.slice(start, end).trim()}${tail}`, end };
}

/** Lets /api/favicon serve this site's icon to the user; recording never fails the fetch. */
export function rememberSource(userId: string, card: PageMeta): void {
	try {
		rememberSourceSite(getDb(), userId, card.url, card.favicon);
	} catch (e) {
		log.warn('Recording source site failed:', {
			error: e instanceof Error ? e.message : String(e)
		});
	}
}

export function createWebfetchServer(ctx?: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-webfetch', version: '0.1.0' });
	server.registerTool(
		'fetch',
		{
			description:
				'Fetch a URL as text. HTML pages come as markdown (default) or plain text of their main ' +
				'content, or as raw html; events the page declares in structured data are listed first. ' +
				`Returns up to max_length characters (default ${DEFAULT_MAX_CHARS}); a longer page says ` +
				'which start_index continues it. ' +
				'Text responses only: save PDFs, images and other binary files to the workspace with fs_curl. ' +
				'To cite fetched pages, cite inline as [1], [2]… and end your answer with a ' +
				'```links block of {"links":[{"url":"…"}, …]} (the pages’ URLs, in citation order).',
			inputSchema: {
				url: z.string(),
				format: z.enum(['markdown', 'text', 'html']).optional(),
				max_length: z
					.number()
					.int()
					.min(500)
					.max(MAX_CHARS)
					.optional()
					.describe(`Characters to return; default ${DEFAULT_MAX_CHARS}`),
				start_index: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe('Character offset to continue a long page from')
			}
		},
		async ({ url, format, max_length, start_index }) => {
			const fmt = format ?? 'markdown';
			const show = (full: string, truncated: boolean) => {
				const window = textWindow(full, start_index ?? 0, max_length ?? DEFAULT_MAX_CHARS);
				// The 1 MB read limit only matters once the window reaches what was read.
				const cut = truncated && window.end >= full.length ? '\n… truncated' : '';
				return `${window.text}${cut}`;
			};
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
			const contentType = res.headers.get('content-type') ?? '';
			const mime = contentType.split(';')[0].trim().toLowerCase();
			if (mime && !isTextType(mime)) {
				await res.body?.cancel().catch(() => {});
				return binaryError(mime);
			}
			let limited;
			try {
				limited = await readBodyLimited(res, MAX_BYTES);
			} catch (e) {
				return err(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			// Untyped responses are sniffed: NUL bytes don't occur in text.
			if (!mime && limited.body.subarray(0, 8192).includes(0)) {
				return binaryError('binary (no content type)');
			}
			const body = limited.body.toString('utf-8');
			if (!/text\/html|application\/xhtml/i.test(mime)) return text(show(body, limited.truncated));
			const pageUrl = res.url || url;
			let page: string;
			if (fmt === 'html') {
				page = body;
			} else {
				const content = mainContent(body);
				const converted = fmt === 'text' ? htmlToText(content) : htmlToMarkdown(content, pageUrl);
				const events = structuredEvents(body, pageUrl);
				page = events ? `${events}\n\n---\n\n${converted}` : converted;
			}
			const card = extractPageMeta(body, pageUrl);
			if (ctx) rememberSource(ctx.userId, card);
			// The card is for the chat's ```links widget only: the model gets `content`.
			const sources = pageUrl === url ? [card] : [card, { ...card, url }];
			return {
				content: [{ type: 'text', text: show(page, limited.truncated) }],
				structuredContent: { sources }
			};
		}
	);
	return server;
}
