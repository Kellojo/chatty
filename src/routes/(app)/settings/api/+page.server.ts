import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getApiKeyUsageStats } from '$lib/server/db/repo/api-key-usage.js';
import { listApiKeys, toPublic } from '$lib/server/db/repo/api-keys.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import { parseUsagePeriod, periodDays } from '$lib/components/app/usage/usage.js';
import type { PageServerLoad } from './$types';

/** The usage line under each key covers this many days, whatever the Statistics tab shows. */
const KEY_USAGE_DAYS = 30;

export const load: PageServerLoad = ({ locals, url }) => {
	const user = requireUser(locals);
	const db = getDb();
	const period = parseUsagePeriod(url.searchParams.get('period'));
	const days = periodDays(period);
	const stats = getApiKeyUsageStats(db, user.id, days);
	const recent = days === KEY_USAGE_DAYS ? stats : getApiKeyUsageStats(db, user.id, KEY_USAGE_DAYS);
	return {
		apiKeys: listApiKeys(db, user.id).map(toPublic),
		timeFormat: getTimeFormat(db, user.id),
		/** Per key id, over the last KEY_USAGE_DAYS days. */
		keyUsage: Object.fromEntries(recent.keys.map((k) => [k.keyId, k])),
		keyUsageDays: KEY_USAGE_DAYS,
		/** The Statistics tab, over the `?period=` it shows. */
		stats: { period, ...stats }
	};
};
