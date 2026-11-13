import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { countConcepts } from '$lib/server/memory/bundle.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ count: countConcepts(getDb(), 'user', user.id) });
};
