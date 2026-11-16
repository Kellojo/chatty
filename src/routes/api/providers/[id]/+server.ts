import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	deleteProvider,
	getProvider,
	toPublic,
	updateProvider
} from '$lib/server/db/repo/providers.js';
import type { RequestHandler } from './$types';

const patchSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	type: z.enum(['anthropic', 'openai-compatible']).optional(),
	baseUrl: z.url().nullable().optional(),
	apiKey: z.string().min(1).nullable().optional(),
	enabled: z.boolean().optional(),
	allowPrivate: z.boolean().optional()
});

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const provider = updateProvider(getDb(), params.id, parsed.data);
	if (!provider) error(404, { message: 'Provider not found' });
	return json({ provider: toPublic(provider) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	if (!getProvider(getDb(), params.id)) error(404, { message: 'Provider not found' });
	deleteProvider(getDb(), params.id);
	return json({ ok: true });
};
