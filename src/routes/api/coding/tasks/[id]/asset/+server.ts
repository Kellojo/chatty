import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { fetchCodingImage } from '$lib/server/t3/assets.js';
import { CodingTaskError } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

/** An image the coding agent referenced by a path on its own machine. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const user = requireUser(locals);
	const path = url.searchParams.get('path');
	if (!path) error(400, { message: 'Missing path' });
	try {
		const image = await fetchCodingImage(getDb(), user.id, params.id, path);
		return new Response(image.bytes as BodyInit, {
			headers: {
				'content-type': image.contentType,
				'cache-control': 'private, max-age=3600',
				'x-content-type-options': 'nosniff',
				'content-security-policy': "default-src 'none'; sandbox"
			}
		});
	} catch (e) {
		if (e instanceof CodingTaskError) error(e.status, { message: e.message });
		throw e;
	}
};
