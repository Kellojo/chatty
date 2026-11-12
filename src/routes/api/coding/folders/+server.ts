import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { browseCodingFolders } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

/** Folder suggestions on a coding environment for a partially typed `path`. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireUser(locals);
	const environmentId = url.searchParams.get('environmentId');
	const path = url.searchParams.get('path')?.trim();
	if (!environmentId || !path) error(400, { message: 'environmentId and path are required' });
	if (path.length > 4096) error(400, { message: 'Path is too long' });
	return json(await codingRoute(() => browseCodingFolders(user.id, environmentId, path)));
};
