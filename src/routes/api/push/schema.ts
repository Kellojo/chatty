import { z } from 'zod';
import { isPushServiceEndpoint } from '$lib/server/push/endpoints.js';

/** A push service endpoint: a known service over https, bounded in size. */
export const endpointSchema = z
	.string()
	.max(2048)
	.refine(isPushServiceEndpoint, { message: 'not a known push service endpoint' });

/** `PushSubscription.toJSON()` as the browser sends it. */
export const subscriptionSchema = z.object({
	endpoint: endpointSchema,
	keys: z.object({
		p256dh: z.string().min(1).max(256),
		auth: z.string().min(1).max(256)
	})
});
