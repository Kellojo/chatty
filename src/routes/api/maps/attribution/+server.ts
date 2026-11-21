import { error, isHttpError, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { createLogger } from '$lib/server/logger.js';
import { loadCopyright } from '$lib/server/maps/service.js';
import type { RequestHandler } from './$types';

const log = createLogger('maps');

const coordinate = (raw: string | null, max: number) => {
	const n = raw === null ? NaN : Number(raw);
	return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
};

/**
 * The copyright line Google requires under its tiles for the shown area, as
 * `{ copyright }`, from `?zoom&north&south&east&west`.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, { message: 'Unauthorized' });
	const p = url.searchParams;
	const zoom = coordinate(p.get('zoom'), 22);
	const north = coordinate(p.get('north'), 90);
	const south = coordinate(p.get('south'), 90);
	const east = coordinate(p.get('east'), 180);
	const west = coordinate(p.get('west'), 180);
	if (zoom === null || north === null || south === null || east === null || west === null) {
		error(400, { message: 'Give zoom, north, south, east and west' });
	}
	try {
		const copyright = await loadCopyright(getDb(), {
			zoom: Math.round(zoom),
			north,
			south,
			east,
			west
		});
		if (copyright === null) error(404, { message: 'Google Maps is not configured' });
		return json({ copyright }, { headers: { 'cache-control': 'private, max-age=3600' } });
	} catch (e) {
		if (isHttpError(e)) throw e;
		log.warn(`Google attribution failed: ${e instanceof Error ? e.message : String(e)}`);
		error(502, { message: 'Could not load the map attribution' });
	}
};
