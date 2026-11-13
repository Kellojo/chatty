import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { countProxyRequests } from '$lib/server/db/repo/proxy-requests.js';
import type { RequestHandler } from './$types';

/** The admin sidebar's request badge; refetched on every request start/finish. */
export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const { total, running } = countProxyRequests(getDb());
	return json({ count: total, running });
};
