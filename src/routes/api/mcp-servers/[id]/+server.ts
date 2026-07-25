import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { deleteMcpServer, toPublic, updateMcpServer } from '$lib/server/db/repo/mcp-servers.js';
import type { RequestHandler } from './$types';

const patchSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9-]*$/)
		.optional(),
	transport: z.enum(['http', 'sse']).optional(),
	url: z.url().nullish(),
	token: z.string().min(1).nullable().optional(),
	enabled: z.boolean().optional()
});

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const server = updateMcpServer(getDb(), params.id, parsed.data);
	if (!server) error(404, { message: 'Server not found' });
	return json({ server: toPublic(server) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	if (!deleteMcpServer(getDb(), params.id)) {
		error(404, { message: 'Server not found or builtin' });
	}
	return json({ ok: true });
};
