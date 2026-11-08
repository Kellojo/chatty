import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { searchMemoryFts } from '$lib/server/memory/fts.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return json({ results: [] });
	const scopes = [`user:${user.id}`];
	if ((user as { role?: string }).role === 'admin') scopes.push('shared');
	return json({ results: searchMemoryFts(getDb(), scopes, q, 10, { html: true }) });
};
