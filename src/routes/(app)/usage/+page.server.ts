import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { loadPaygUsage, loadSubscriptionUsage, usageWindow } from './usage-data.server.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const user = requireUser(locals);
	const db = getDb();
	const window = usageWindow(url);
	return {
		period: window.period,
		periodDays: window.days.length,
		// Overview counts only your own usage; admins' Requests tab defaults to everyone, so links
		// from here pin the log to you and the numbers match.
		requestsUser: (user as { role?: string }).role === 'admin' ? user.id : '',
		payg: loadPaygUsage(db, user.id, window),
		subscriptions: loadSubscriptionUsage(db, user.id, window)
	};
};
