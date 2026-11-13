import { getDb } from '$lib/server/db/index.js';
import { getTheme } from '$lib/server/db/repo/user-settings.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		theme: locals.user ? getTheme(getDb(), locals.user.id) : 'system'
	};
};
