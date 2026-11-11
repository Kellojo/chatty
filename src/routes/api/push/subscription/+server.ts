import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	deletePushSubscription,
	getPushSubscriptionOwner,
	upsertPushSubscription
} from '$lib/server/db/repo/push-subscriptions.js';
import { endpointSchema, subscriptionSchema } from '../schema.js';
import type { RequestHandler } from './$types';

/** Whether this browser's push registration is the caller's (nothing more is said about it). */
export type PushOwner = 'you' | 'not-you';

const putSchema = subscriptionSchema.extend({
	/**
	 * Set when a device re-registers on its own (app start): the account that
	 * turned push on there. Another account signed in since must opt in itself
	 * rather than inherit the device.
	 */
	owner: z.string().min(1).max(200).optional(),
	/** Set by the service worker when the browser rotates a subscription: the old endpoint. */
	replaces: endpointSchema.optional()
});

async function parse<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid push subscription' });
	return parsed.data;
}

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const endpoint = endpointSchema.safeParse(url.searchParams.get('endpoint'));
	if (!endpoint.success) error(400, { message: 'Invalid endpoint' });
	const owner: PushOwner =
		getPushSubscriptionOwner(getDb(), endpoint.data) === user.id ? 'you' : 'not-you';
	return json({ owner });
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	if (!locals.session) error(401, { message: 'Authentication required' });
	const body = await parse(request, putSchema);
	const db = getDb();
	const notYours = 'Push on this device was turned on by another account';
	if (body.owner !== undefined && body.owner !== user.id) error(409, { message: notYours });
	if (body.replaces !== undefined && getPushSubscriptionOwner(db, body.replaces) !== user.id) {
		error(409, { message: notYours });
	}
	const sessionId = locals.session.id;
	// A rotation swaps old for new in one step: never both, never neither.
	db.transaction(() => {
		if (body.replaces !== undefined) deletePushSubscription(db, user.id, body.replaces);
		upsertPushSubscription(db, user.id, {
			sessionId,
			endpoint: body.endpoint,
			p256dh: body.keys.p256dh,
			auth: body.keys.auth,
			userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null
		});
	})();
	return json({ ok: true, userId: user.id });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await parse(request, z.object({ endpoint: endpointSchema }));
	deletePushSubscription(getDb(), user.id, body.endpoint);
	return json({ ok: true });
};
