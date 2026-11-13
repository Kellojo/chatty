import { requireUser } from '$lib/server/auth/guards.js';
import { listTree } from '$lib/server/memory/bundle.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);
	return { tree: await listTree('user', user.id) };
};
