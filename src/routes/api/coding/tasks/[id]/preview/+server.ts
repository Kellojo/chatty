import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { listCodingPreviewTabs } from '$lib/server/t3/preview.js';
import type { RequestHandler } from './$types';

/** The browser tabs the coding agent has open for this task. */
export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const tabs = await codingRoute(() => listCodingPreviewTabs(getDb(), user.id, params.id));
	return json({ tabs });
};
