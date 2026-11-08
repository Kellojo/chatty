import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { getCodingTaskDiff } from '$lib/server/t3/review.js';
import type { RequestHandler } from './$types';

/** The task's changes as per-file diffs (working tree and branch), read from T3. */
export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	return json(await codingRoute(() => getCodingTaskDiff(getDb(), user.id, params.id)));
};
