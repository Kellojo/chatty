import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { deleteMcpServer, toPublic, updateMcpServer } from '$lib/server/db/repo/mcp-servers.js';
import { isAdminActor, requireManageableMcpServer } from '$lib/server/mcp/access.js';
import { invalidateMcpServer } from '$lib/server/mcp/pool.js';
import { mcpServerPatchSchema, resolveMcpServerPatch } from '$lib/server/mcp/serverInput.js';
import type { RequestHandler } from './$types';

// Shared servers are admin-only, personal ones their owner's. Only admins may
// make a server stdio: it runs an arbitrary command on the host.
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = mcpServerPatchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	const existing = requireManageableMcpServer(db, params.id, user);
	const resolved = resolveMcpServerPatch(existing, parsed.data);
	if (!resolved.ok) error(400, { message: resolved.error });
	if (!isAdminActor(user) && resolved.value.transport === 'stdio') {
		error(403, { message: 'Admin required' });
	}
	const server = updateMcpServer(db, params.id, resolved.value);
	if (!server) error(404, { message: 'Server not found' });
	invalidateMcpServer(params.id);
	return json({ server: toPublic(server) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	requireManageableMcpServer(db, params.id, user);
	if (!deleteMcpServer(db, params.id)) {
		error(404, { message: 'Server not found or builtin' });
	}
	invalidateMcpServer(params.id);
	return json({ ok: true });
};
