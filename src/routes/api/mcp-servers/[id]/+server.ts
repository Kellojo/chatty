import { json, error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	deleteMcpServer,
	getMcpServer,
	toPublic,
	updateMcpServer
} from '$lib/server/db/repo/mcp-servers.js';
import { invalidateMcpServer } from '$lib/server/mcp/pool.js';
import { mcpServerPatchSchema, resolveMcpServerPatch } from '$lib/server/mcp/serverInput.js';
import type { RequestHandler } from './$types';

// Admin-only: stdio servers run an arbitrary command on the host.
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const parsed = mcpServerPatchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	const existing = getMcpServer(db, params.id);
	if (!existing) error(404, { message: 'Server not found' });
	const resolved = resolveMcpServerPatch(existing, parsed.data);
	if (!resolved.ok) error(400, { message: resolved.error });
	const server = updateMcpServer(db, params.id, resolved.value);
	if (!server) error(404, { message: 'Server not found' });
	invalidateMcpServer(params.id);
	return json({ server: toPublic(server) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	if (!deleteMcpServer(getDb(), params.id)) {
		error(404, { message: 'Server not found or builtin' });
	}
	invalidateMcpServer(params.id);
	return json({ ok: true });
};
