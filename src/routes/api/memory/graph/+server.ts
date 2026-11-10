import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { buildMemoryGraph } from '$lib/server/memory/graph.js';
import type { RequestHandler } from './$types';

/** The user's memories, plus shared ones for admins (the only ones who can open them). */
export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const isAdmin = (user as { role?: string }).role === 'admin';
	return json(await buildMemoryGraph(isAdmin ? ['user', 'shared'] : ['user'], user.id));
};
