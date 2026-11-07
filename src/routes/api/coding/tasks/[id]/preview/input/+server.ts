import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { MAX_PREVIEW_INPUT_BATCH } from '$lib/coding-preview.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { sendPreviewInput } from '$lib/server/t3/preview.js';
import type { RequestHandler } from './$types';

// Messages are checked field by field in sendPreviewInput; this only bounds the batch.
const inputSchema = z.object({
	viewerId: z.string().uuid(),
	messages: z.array(z.unknown()).min(1).max(MAX_PREVIEW_INPUT_BATCH)
});

/** Mouse, keyboard and navigation input for an open browser preview. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = inputSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const { viewerId, messages } = parsed.data;
	if (!sendPreviewInput(user.id, params.id, viewerId, messages)) {
		error(410, { message: 'The preview is no longer open' });
	}
	return json({ ok: true });
};
