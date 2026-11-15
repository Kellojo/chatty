import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getDefaultVoice, setDefaultVoice } from '$lib/server/speech/synthesizer.js';
import type { RequestHandler } from './$types';

const putSchema = z.object({ voice: z.string().max(100) });

/** Sets the voice the Text to speech default reads with; '' clears it. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const parsed = putSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid request body' });
	const db = getDb();
	setDefaultVoice(db, parsed.data.voice);
	return json({ voice: getDefaultVoice(db) });
};
