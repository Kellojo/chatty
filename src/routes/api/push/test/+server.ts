import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listPushSubscriptions } from '$lib/server/db/repo/push-subscriptions.js';
import { sendPushToUser } from '$lib/server/push/dispatcher.js';
import { endpointSchema } from '../schema.js';
import type { RequestHandler } from './$types';

/** Sends a test push to one of the user's devices, ignoring presence. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = z
		.object({ endpoint: endpointSchema })
		.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid endpoint' });
	const db = getDb();
	// The same devices real notices go to (live session), so a passing test means something.
	const sub = listPushSubscriptions(db, user.id).find((s) => s.endpoint === parsed.data.endpoint);
	if (!sub) error(404, { message: 'This device is not subscribed' });
	const result = await sendPushToUser(
		db,
		user.id,
		{
			title: 'Chatty',
			body: 'Push notifications are working.',
			tag: 'test',
			url: '/',
			kind: 'test',
			createdAt: Date.now()
		},
		{ only: [sub] }
	);
	if (result.sent === 0) {
		error(502, {
			message:
				result.removed > 0
					? 'The push service no longer knows this device. Turn push off and on again.'
					: 'The push service rejected the test. Check the server logs.'
		});
	}
	return json({ ok: true });
};
