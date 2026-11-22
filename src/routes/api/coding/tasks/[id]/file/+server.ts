import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { readCodingFile } from '$lib/server/t3/files.js';
import { codingRoute } from '$lib/server/t3/http.js';
import type { RequestHandler } from './$types';

/** A text file the coding agent linked to, read from its machine. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const user = requireUser(locals);
	const path = url.searchParams.get('path');
	if (!path || path.length > 1024) error(400, { message: 'Missing path' });
	const file = await codingRoute(() => readCodingFile(getDb(), user.id, params.id, path));
	return json(file, { headers: { 'cache-control': 'no-store' } });
};
