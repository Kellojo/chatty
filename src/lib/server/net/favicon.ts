import { getDb, type Db } from '../db/index.js';
import { getCachedFavicon, putCachedFavicon } from '../db/repo/favicon-cache.js';
import type { SourceSite } from '../db/repo/source-sites.js';
import { pageIcons, sizeScore } from '../mcp/servers/webfetch.js';
import { readBodyLimited } from './readBody.js';
import { safeFetch } from './safeFetch.js';

/** A site icon, ready to serve. */
export interface Icon {
	body: Buffer;
	type: string;
}

export const MAX_ICON_BYTES = 256 * 1024;
/** Only the start of a home page is read for its <head>. */
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
/** Per request, and for the whole search for one site's icon. */
const REQUEST_TIMEOUT_MS = 5000;
const SEARCH_TIMEOUT_MS = 15_000;
/** Most icon URLs tried per site, so a page listing dozens can't keep the server busy. */
const MAX_ATTEMPTS = 8;
/** Found icons are kept (in the database) this long. */
export const ICON_TTL_MS = 30 * 24 * 60 * 60_000;
/** Sites without a usable icon are retried after this long (remembered in memory only). */
const MISS_TTL_MS = 60 * 60_000;
const MAX_MISSES = 1000;
const USER_AGENT = 'ai-chat/0.1 (+https://localhost)';

/** The image type of `body`, from its magic bytes; SVG by its root element. */
export function sniffImageType(body: Buffer): string | null {
	const starts = (...bytes: number[]) => bytes.every((b, i) => body[i] === b);
	if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
	if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
	if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
	if (starts(0x42, 0x4d)) return 'image/bmp';
	if (
		body.subarray(0, 4).toString('latin1') === 'RIFF' &&
		body.subarray(8, 12).toString('latin1') === 'WEBP'
	) {
		return 'image/webp';
	}
	if (body.subarray(4, 12).toString('latin1') === 'ftypavif') return 'image/avif';
	const head = body
		.subarray(0, 1024)
		.toString('utf-8')
		.replace(/^\uFEFF/, '')
		.trimStart();
	if (
		/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)
	) {
		return 'image/svg+xml';
	}
	return null;
}

/** GET with the SSRF guard, no cookies or credentials, and a per-request timeout. */
function get(url: string, accept: string, signal: AbortSignal): Promise<Response> {
	return safeFetch(url, {
		headers: { accept, 'user-agent': USER_AGENT },
		credentials: 'omit',
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
	});
}

async function discard(res: Response): Promise<void> {
	await res.body?.cancel().catch(() => {});
}

/** Fetch one icon URL. Null unless the response is an image within the size cap. */
async function fetchIcon(url: string, signal: AbortSignal): Promise<Icon | null> {
	let res: Response;
	try {
		res = await get(url, 'image/*', signal);
	} catch {
		return null;
	}
	if (!res.ok) {
		await discard(res);
		return null;
	}
	const declared = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	// HTML error pages served with 200 are common; anything clearly not an image is skipped unread.
	if (
		declared &&
		!declared.startsWith('image/') &&
		!/^(?:application\/octet-stream|text\/plain|binary\/octet-stream)$/.test(declared)
	) {
		await discard(res);
		return null;
	}
	let body: Buffer;
	try {
		const limited = await readBodyLimited(res, MAX_ICON_BYTES);
		if (limited.truncated || limited.body.length === 0) return null;
		body = limited.body;
	} catch {
		return null;
	}
	const sniffed = sniffImageType(body);
	if (sniffed) return { body, type: sniffed };
	// Formats not sniffed above are trusted only when declared as a raster image.
	return declared.startsWith('image/') && declared !== 'image/svg+xml'
		? { body, type: declared }
		: null;
}

/** The start of a text response (a home page or a manifest), with its final URL, or null. */
async function fetchText(
	url: string,
	accept: string,
	maxBytes: number,
	signal: AbortSignal
): Promise<{ text: string; url: string } | null> {
	try {
		const res = await get(url, accept, signal);
		const type = res.headers.get('content-type') ?? '';
		if (!res.ok || /^(?:image|audio|video|font)\//i.test(type)) {
			await discard(res);
			return null;
		}
		const limited = await readBodyLimited(res, maxBytes);
		return { text: limited.body.toString('utf-8'), url: res.url || url };
	} catch {
		return null;
	}
}

/**
 * Icons a web app manifest lists, best first: "any"-purpose before maskable
 * (which has extra padding), SVG or the size closest to 32px. Monochrome-only
 * icons are skipped.
 */
export function manifestIcons(json: string, manifestUrl: string): string[] {
	let icons: unknown;
	try {
		icons = (JSON.parse(json) as { icons?: unknown } | null)?.icons;
	} catch {
		return [];
	}
	if (!Array.isArray(icons)) return [];
	const ranked: { href: string; score: number }[] = [];
	for (const icon of icons as unknown[]) {
		const entry = icon as Record<string, unknown> | null;
		if (typeof entry?.src !== 'string' || !URL.canParse(entry.src, manifestUrl)) continue;
		const href = new URL(entry.src, manifestUrl);
		if (href.protocol !== 'https:' && href.protocol !== 'http:') continue;
		const purposes = String(entry.purpose ?? 'any')
			.toLowerCase()
			.split(/\s+/);
		const any = purposes.includes('any');
		if (!any && !purposes.includes('maskable')) continue;
		const sizes = typeof entry.sizes === 'string' ? entry.sizes : undefined;
		const svg = /svg/i.test(String(entry.type ?? '')) || /\.svg$/i.test(href.pathname);
		const fit = svg || sizes === 'any' ? 0 : (sizeScore(sizes, 32) ?? 1);
		ranked.push({ href: href.href, score: fit + (any ? 0 : 1000) });
	}
	return ranked.sort((a, b) => a.score - b.score).map((r) => r.href);
}

type SiteRef = Pick<SourceSite, 'host' | 'origin' | 'faviconUrl'>;

/**
 * Icon URLs to try for a site, in order and lazily (the later ones cost extra
 * requests): the icon its page declared, /favicon.ico, the icons its home page
 * declares (link icons, apple-touch-icon, the Windows tile image), its web app
 * manifest's icons, and last the conventional /apple-touch-icon.png files.
 */
async function* iconCandidates(site: SiteRef, signal: AbortSignal): AsyncGenerator<string> {
	const at = (path: string) => new URL(path, site.origin).href;
	if (site.faviconUrl) yield site.faviconUrl;
	yield at('/favicon.ico');
	const home = await fetchText(at('/'), 'text/html', MAX_PAGE_BYTES, signal);
	if (home) {
		const { icons, manifest } = pageIcons(home.text, home.url);
		yield* icons;
		if (manifest) {
			const accept = 'application/manifest+json, application/json';
			const json = await fetchText(manifest, accept, MAX_MANIFEST_BYTES, signal);
			if (json) yield* manifestIcons(json.text, json.url);
		}
	}
	yield at('/apple-touch-icon.png');
	yield at('/apple-touch-icon-precomposed.png');
}

/** The first candidate that is an actual image, or null. */
async function findSiteIcon(site: SiteRef): Promise<Icon | null> {
	const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const tried = new Set<string>();
	for await (const url of iconCandidates(site, signal)) {
		if (signal.aborted || tried.size >= MAX_ATTEMPTS) break;
		if (tried.has(url)) continue;
		tried.add(url);
		const icon = await fetchIcon(url, signal);
		if (icon) return icon;
	}
	return null;
}

/** When each host's last search came up empty, so it isn't searched on every render. */
const misses = new Map<string, number>();
/** Searches in progress, so concurrent requests for one site share one. */
const pending = new Map<string, Promise<Icon | null>>();

/**
 * A site's icon: from the database while it's under a month old, else searched
 * for afresh and stored. `site.host` is the source_sites key.
 */
export function loadSiteIcon(
	site: SiteRef,
	{ db = getDb(), now = Date.now() }: { db?: Db; now?: number } = {}
): Promise<Icon | null> {
	const cached = getCachedFavicon(db, site.host);
	if (cached && now - cached.fetchedAt < ICON_TTL_MS) {
		return Promise.resolve({ body: cached.body, type: cached.type });
	}
	const missedAt = misses.get(site.host);
	if (missedAt !== undefined && now - missedAt < MISS_TTL_MS) {
		return Promise.resolve(cached && { body: cached.body, type: cached.type });
	}
	const inFlight = pending.get(site.host);
	if (inFlight) return inFlight;
	const search = findSiteIcon(site)
		.then((icon): Icon | null => {
			if (icon) {
				putCachedFavicon(db, site.host, icon, now);
				misses.delete(site.host);
				return icon;
			}
			misses.set(site.host, now);
			while (misses.size > MAX_MISSES) misses.delete(misses.keys().next().value!);
			// Site down or icon gone: keep showing the expired one until the daily purge.
			return cached && { body: cached.body, type: cached.type };
		})
		.finally(() => pending.delete(site.host));
	pending.set(site.host, search);
	return search;
}

/** Forgets every stored icon and remembered miss (for tests). */
export function clearIconCache(db: Db = getDb()): void {
	misses.clear();
	pending.clear();
	db.prepare('DELETE FROM favicon_cache').run();
}
