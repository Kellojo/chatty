import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { getProjectBranches } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireUser(locals);
	const environmentId = url.searchParams.get('environmentId');
	const projectId = url.searchParams.get('projectId');
	if (!environmentId || !projectId) {
		error(400, { message: 'environmentId and projectId are required' });
	}
	return json(await codingRoute(() => getProjectBranches(user.id, environmentId, projectId)));
};
