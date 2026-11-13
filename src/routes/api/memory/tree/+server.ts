import { json } from '@sveltejs/kit';
import { requireAdmin, requireUser } from '$lib/server/auth/guards.js';
import { listTree } from '$lib/server/memory/bundle.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const scope = url.searchParams.get('scope') === 'shared' ? 'shared' : 'user';
	const user = scope === 'shared' ? requireAdmin(locals) : requireUser(locals);
	return json({ tree: await listTree(scope, user.id) });
};
