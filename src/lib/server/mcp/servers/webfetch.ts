import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readBodyLimited } from '../../net/readBody.js';
import { safeFetch } from '../../net/safeFetch.js';
import { err, text } from './shared.js';

const MAX_BYTES = 1024 * 1024;
/** Only the start of a page is searched for <head> metadata. */
const MAX_HEAD_BYTES = 256 * 1024;

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
				'Fetch a URL as text. HTML pages come as markdown (default), plain text or raw html per format. ' +
				'Text responses only: save PDFs, images and other binary files to the workspace with fs_curl. ' +
				'HTML pages also return a source card; to cite fetched pages, cite inline as [1], [2]… and end your answer with a ' +
				'```links block of {"links":[card, …]} (cards verbatim, in citation order).',
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
			const suffix = limited.truncated ? '\n… truncated' : '';
			if (!/text\/html|application\/xhtml/i.test(mime)) return text(body + suffix);
			const pageUrl = res.url || url;
			const converted =
				fmt === 'html' ? body : fmt === 'text' ? htmlToText(body) : htmlToMarkdown(body, pageUrl);
			const result = text(converted + suffix);
			// The body stays the first content part; the card is an extra part.
			const card = extractPageMeta(body, pageUrl);
			result.content.push({ type: 'text', text: `Source card: ${JSON.stringify(card)}` });
			return result;
		}
	);
	return server;
}
