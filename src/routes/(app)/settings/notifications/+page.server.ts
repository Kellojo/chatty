import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listPushSubscriptions } from '$lib/server/db/repo/push-subscriptions.js';
import { getUserSettings } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	return {
		settings: getUserSettings(db, user.id),
		/** Devices receiving push (this one included), to say when push reaches none. */
		pushDeviceCount: listPushSubscriptions(db, user.id).length
	};
};
