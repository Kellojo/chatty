import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listCodingEnvironments, toPublic } from '$lib/server/db/repo/coding-environments.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	return { environments: listCodingEnvironments(getDb(), user.id).map(toPublic) };
};
