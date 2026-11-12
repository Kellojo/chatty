import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import {
	AdminUserError,
	createPasswordUser,
	passwordLoginEnabled
} from '$lib/server/auth/users.js';
import { getDb } from '$lib/server/db/index.js';
import { getUser, listUsers } from '$lib/server/db/repo/users.js';
import type { RequestHandler } from './$types';

const createSchema = z.object({
	name: z.string().trim().min(1, 'Name is required').max(200),
	email: z.email('Enter a valid email address'),
	password: z.string().min(1, 'Password is required'),
	role: z.enum(['admin', 'user']).default('user')
});

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json({ users: listUsers(getDb()) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	if (!passwordLoginEnabled()) {
		error(400, { message: 'Password sign-in is disabled on this instance' });
	}
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	try {
		const id = await createPasswordUser(parsed.data);
		return json({ user: getUser(getDb(), id) }, { status: 201 });
	} catch (e) {
		if (e instanceof AdminUserError) error(400, { message: e.message });
		throw e;
	}
};
