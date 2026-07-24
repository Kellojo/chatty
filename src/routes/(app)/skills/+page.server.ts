import { requireUser } from '$lib/server/auth/guards.js';
import { listAllSkills } from '$lib/server/skills/scanner.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	return {
		skills: listAllSkills(user.id),
		isAdmin: (user as { role?: string }).role === 'admin'
	};
};
