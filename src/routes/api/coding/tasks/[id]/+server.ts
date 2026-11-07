import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	getCodingConversationForUser,
	toPublic
} from '$lib/server/db/repo/coding-conversations.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = getCodingConversationForUser(getDb(), user.id, params.id);
	if (!row) error(404, { message: 'Coding task not found' });
	return json({ coding: toPublic(row) });
};
