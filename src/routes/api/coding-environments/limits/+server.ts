import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listCodingEnvironments,
	listUsageLimits
} from '$lib/server/db/repo/coding-environments.js';
import { groupUsageAccounts } from '$lib/components/app/usage/usage.js';
import type { RequestHandler } from './$types';

/** Subscription plan limits per provider account, as last synced (for the sidebar). */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	const names = new Map(listCodingEnvironments(db, user.id).map((e) => [e.id, e.name]));
	return json({ accounts: groupUsageAccounts(listUsageLimits(db, user.id), names) });
};
