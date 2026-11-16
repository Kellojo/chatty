import type { Db } from '../index.js';

/** A site whose page one of the user's tools fetched. */
export interface SourceSite {
	host: string;
	/** The fetched page's origin, for the /favicon.ico fallback. */
	origin: string;
	/** The icon the page declared, if any. */
	faviconUrl: string | null;
}

/** The key a site is stored and looked up by: lower-cased hostname without "www.". */
export function sourceHostKey(hostname: string): string {
	return hostname
		.trim()
		.toLowerCase()
		.replace(/\.$/, '')
		.replace(/^www\./, '');
}

function httpUrl(v: string | null | undefined): URL | null {
	if (!v || !URL.canParse(v)) return null;
	const u = new URL(v);
	return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
}

/** Records (or refreshes) the site of a page a tool fetched for the user. Ignores non-http(s) URLs. */
export function rememberSourceSite(
	db: Db,
	userId: string,
	pageUrl: string,
	faviconUrl?: string | null,
	at = Date.now()
): void {
	const page = httpUrl(pageUrl);
	if (!page) return;
	const host = sourceHostKey(page.hostname);
	if (!host) return;
	db.prepare(
		`INSERT INTO source_sites (user_id, host, origin, favicon_url, seen_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (user_id, host) DO UPDATE SET
		   origin = excluded.origin,
		   favicon_url = COALESCE(excluded.favicon_url, favicon_url),
		   seen_at = excluded.seen_at`
	).run(userId, host, page.origin, httpUrl(faviconUrl)?.href ?? null, at);
}

export function findSourceSite(db: Db, userId: string, host: string): SourceSite | null {
	const row = db
		.prepare('SELECT host, origin, favicon_url FROM source_sites WHERE user_id = ? AND host = ?')
		.get(userId, sourceHostKey(host)) as
		{ host: string; origin: string; favicon_url: string | null } | undefined;
	return row ? { host: row.host, origin: row.origin, faviconUrl: row.favicon_url } : null;
}
