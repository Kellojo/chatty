import { error, json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { promoteSkill } from '$lib/server/skills/store.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireAdmin(locals);
	try {
		const skill = promoteSkill(user.id, params.name);
		publishServerEvent(user.id, { type: 'skills.changed' });
		return json({ skill });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Failed to promote skill' });
	}
};
