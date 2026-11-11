import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { reportPresence } from '$lib/server/push/presence.js';
import type { RequestHandler } from './$types';

const schema = z.object({
	clientId: z.string().min(8).max(64),
	/** The app path the tab shows; null while hidden or closing. */
	path: z.string().startsWith('/').max(512).nullable(),
	/** Milliseconds since the tab was last touched. */
	idleMs: z.number().int().min(0).max(86_400_000)
});

/** A tab reports what it shows and when you last touched it; pushes wait accordingly. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	// sendBeacon posts text/plain, so parse the body by hand.
	const parsed = schema.safeParse(
		await request
			.text()
			.then((t) => JSON.parse(t))
			.catch(() => null)
	);
	if (!parsed.success) error(400, { message: 'Invalid presence report' });
	const { clientId, ...report } = parsed.data;
	reportPresence(user.id, clientId, report);
	return json({ ok: true });
};
