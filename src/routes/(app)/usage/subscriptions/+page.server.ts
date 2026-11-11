import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { loadLimitHistory, loadSubscriptionUsage, usageWindow } from '../usage-data.server.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const user = requireUser(locals);
	const window = usageWindow(url);
	const db = getDb();
	return {
		period: window.period,
		rangeLabel: window.label,
		subscriptions: loadSubscriptionUsage(db, user.id, window),
		limitHistory: loadLimitHistory(db, user.id, window),
		// The burn-down charts follow the selected range (open ends stay open).
		limitRange: { from: window.fromMs ?? null, to: window.toMs ?? null }
	};
};
