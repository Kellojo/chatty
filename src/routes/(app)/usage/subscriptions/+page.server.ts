import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { loadSubscriptionUsage, usageWindow } from '../usage-data.server.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const user = requireUser(locals);
	const window = usageWindow(url);
	return {
		period: window.period,
		rangeLabel: window.label,
		subscriptions: loadSubscriptionUsage(getDb(), user.id, window)
	};
};
