import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { loadPlacePhoto, photoName } from '$lib/server/maps/service.js';
import { noImage, proxyImage } from '../../images.js';
import type { RequestHandler } from './$types';

/**
 * A Google place photo from one of the user's own place searches. The model and the
 * map widget only ever see this URL: the photo name stays on the server, and so does
 * the key, which Google wants on every photo request.
 */
export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) error(401, { message: 'Unauthorized' });
	const name = photoName(params.id, locals.user.id);
	if (!name) return noImage();
	return proxyImage('photo', () => loadPlacePhoto(getDb(), name));
};
