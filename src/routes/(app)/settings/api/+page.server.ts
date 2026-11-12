import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listApiKeys, toPublic } from '$lib/server/db/repo/api-keys.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	return {
		apiKeys: listApiKeys(db, user.id).map(toPublic),
		timeFormat: getTimeFormat(db, user.id)
	};
};
