import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { deleteModel, toPublic, updateModel } from '$lib/server/db/repo/models.js';
import type { RequestHandler } from './$types';

const patchSchema = z.object({
	displayName: z.string().min(1).max(200).optional(),
	capabilities: z.array(z.enum(['chat', 'vision', 'tool_use', 'streaming', 'image'])).optional(),
	enabled: z.boolean().optional(),
	priceInput: z.number().nonnegative().nullable().optional(),
	priceOutput: z.number().nonnegative().nullable().optional()
});

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const model = updateModel(getDb(), params.id, parsed.data);
	if (!model) error(404, { message: 'Model not found' });
	return json({ model: toPublic(model) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	if (!deleteModel(getDb(), params.id)) error(404, { message: 'Model not found' });
	return json({ ok: true });
};
