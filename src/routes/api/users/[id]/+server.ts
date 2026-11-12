import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { AdminUserError, passwordLoginEnabled, setUserPassword } from '$lib/server/auth/users.js';
import { getDb } from '$lib/server/db/index.js';
import {
	deleteUser,
	deleteUserSessions,
	getUser,
	renameUser,
	setUserRole
} from '$lib/server/db/repo/users.js';
import type { RequestHandler } from './$types';

const patchSchema = z
	.object({
		name: z.string().trim().min(1, 'Name is required').max(200).optional(),
		role: z.enum(['admin', 'user']).optional(),
		password: z.string().min(1, 'Password is required').optional(),
		/** Sign the user out on every device. */
		signOut: z.literal(true).optional()
	})
	.refine((body) => Object.values(body).some((value) => value !== undefined), 'Nothing to update');

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const admin = requireAdmin(locals);
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const body = parsed.data;
	const db = getDb();
	if (!getUser(db, params.id)) error(404, { message: 'User not found' });

	// Your own role, password and sessions are managed elsewhere (Account), and
	// changing them here would lock you out mid-request.
	const self = params.id === admin.id;
	if (self && (body.role !== undefined || body.password !== undefined || body.signOut)) {
		error(400, { message: "You can't change your own role, password or sessions here" });
	}

	if (body.name !== undefined) {
		const result = renameUser(db, params.id, body.name);
		if (!result.ok) error(result.status, { message: result.message });
	}
	if (body.role !== undefined) {
		const result = setUserRole(db, params.id, body.role);
		if (!result.ok) error(result.status, { message: result.message });
	}
	if (body.password !== undefined) {
		if (!passwordLoginEnabled()) {
			error(400, { message: 'Password sign-in is disabled on this instance' });
		}
		try {
			await setUserPassword(params.id, body.password);
		} catch (e) {
			if (e instanceof AdminUserError) error(400, { message: e.message });
			throw e;
		}
	}
	if (body.signOut) deleteUserSessions(db, params.id);

	return json({ user: getUser(db, params.id) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const admin = requireAdmin(locals);
	if (params.id === admin.id) error(400, { message: "You can't delete your own account" });
	const result = deleteUser(getDb(), params.id);
	if (!result.ok) error(result.status, { message: result.message });
	return json({ ok: true });
};
