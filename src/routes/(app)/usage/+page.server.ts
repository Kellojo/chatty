import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	firstPaygRequest,
	loadPaygUsage,
	loadSubscriptionUsage,
	usageWindow
} from './usage-data.server.js';
import { RANGE_PARAMS } from '$lib/components/app/usage/usage.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const user = requireUser(locals);
	const db = getDb();
	const window = usageWindow(url, Date.now(), firstPaygRequest(db, user.id));
	return {
		period: window.period,
		rangeLabel: window.label,
		// The range params as given, so links to other tabs keep the same range.
		rangeParams: Object.fromEntries(
			RANGE_PARAMS.flatMap((key) => {
				const value = url.searchParams.get(key);
				return value ? [[key, value]] : [];
			})
		),
		// Overview counts only your own usage; admins' Requests tab defaults to everyone, so links
		// from here pin the log to you and the numbers match.
		requestsUser: (user as { role?: string }).role === 'admin' ? user.id : '',
		payg: loadPaygUsage(db, user.id, window),
		subscriptions: loadSubscriptionUsage(db, user.id, window)
	};
};
