import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { auth } from '$lib/server/auth/index.js';

const bodySchema = z.object({
	currentPassword: z.string().min(1, 'Current password is required'),
	newPassword: z.string().min(8, 'New password must be at least 8 characters')
});

export const POST = async ({ locals, request }) => {
	requireUser(locals);
	const body = await request.json().catch(() => null);
	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) error(400, { message: 'Invalid request body' });

	try {
		await auth.api.changePassword({
			headers: request.headers,
			body: {
				newPassword: parsed.data.newPassword,
				currentPassword: parsed.data.currentPassword
			}
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Failed to update password';
		error(400, { message });
	}

	return json({ success: true });
};
