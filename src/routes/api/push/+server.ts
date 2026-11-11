import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getVapidDetails } from '$lib/server/push/vapid.js';
import type { RequestHandler } from './$types';

/** The VAPID public key a browser subscribes with. */
export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return json({ publicKey: getVapidDetails(getDb()).publicKey });
};
