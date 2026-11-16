import type { Db } from '../index.js';

/** A cached site icon. */
export interface CachedFavicon {
	type: string;
	body: Buffer;
	fetchedAt: number;
}

export function getCachedFavicon(db: Db, host: string): CachedFavicon | null {
	const row = db
		.prepare('SELECT type, body, fetched_at FROM favicon_cache WHERE host = ?')
		.get(host) as { type: string; body: Buffer; fetched_at: number } | undefined;
	return row ? { type: row.type, body: row.body, fetchedAt: row.fetched_at } : null;
}

export function putCachedFavicon(
	db: Db,
	host: string,
	icon: { type: string; body: Buffer },
	at = Date.now()
): void {
	db.prepare(
		`INSERT INTO favicon_cache (host, type, body, fetched_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (host) DO UPDATE SET
		   type = excluded.type, body = excluded.body, fetched_at = excluded.fetched_at`
	).run(host, icon.type, icon.body, at);
}

/** Removes icons fetched before `before` (ms); returns how many. */
export function purgeCachedFavicons(db: Db, before: number): number {
	return db.prepare('DELETE FROM favicon_cache WHERE fetched_at < ?').run(before).changes;
}
