import { requireAdmin } from '$lib/server/auth/guards.js';
import { passwordLoginEnabled } from '$lib/server/auth/users.js';
import { getDb } from '$lib/server/db/index.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import { listUsers } from '$lib/server/db/repo/users.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const admin = requireAdmin(locals);
	const db = getDb();
	return {
		users: listUsers(db),
		timeFormat: getTimeFormat(db, admin.id),
		passwordLogin: passwordLoginEnabled()
	};
};
