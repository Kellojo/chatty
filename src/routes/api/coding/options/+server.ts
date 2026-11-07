import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listCodingEnvironments, toPublic } from '$lib/server/db/repo/coding-environments.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { getCodingOptions } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

/**
 * Without `environmentId`: the user's enabled environments.
 * With it: that environment's projects and models (connects to the server).
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireUser(locals);
	const environmentId = url.searchParams.get('environmentId');
	if (!environmentId) {
		const environments = listCodingEnvironments(getDb(), user.id)
			.filter((e) => e.enabled === 1)
			.map(toPublic);
		return json({ environments });
	}
	return json(await codingRoute(() => getCodingOptions(user.id, environmentId)));
};
