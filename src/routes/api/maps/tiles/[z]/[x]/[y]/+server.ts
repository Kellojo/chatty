import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { loadTile } from '$lib/server/maps/service.js';
import { noImage, proxyImage } from '../../../../images.js';
import type { RequestHandler } from './$types';

/** Google's roadmap tiles reach zoom 22. */
const MAX_ZOOM = 22;

const int = (s: string) => (/^\d{1,8}$/.test(s) ? Number(s) : NaN);

/** A Google map tile for the map widget, fetched with the server's key and tile session. */
export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) error(401, { message: 'Unauthorized' });
	const [z, x, y] = [int(params.z), int(params.x), int(params.y)];
	const size = 2 ** z;
	if (!(z <= MAX_ZOOM && x < size && y < size)) return noImage();
	return proxyImage('tile', () => loadTile(getDb(), z, x, y));
};
