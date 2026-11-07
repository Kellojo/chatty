import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getCodingEnvironment, toPublic } from '$lib/server/db/repo/coding-environments.js';
import { syncCodingEnvironment } from '$lib/server/t3/sync.js';
import type { RequestHandler } from './$types';

/** Connects to the environment now and refreshes its status and usage. */
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const row = getCodingEnvironment(db, user.id, params.id);
	if (!row) error(404, { message: 'Environment not found' });
	return json({ environment: toPublic(await syncCodingEnvironment(db, row)) });
};
