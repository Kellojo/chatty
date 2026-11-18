import { json, error } from '@sveltejs/kit';
import Database from 'better-sqlite3';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { createMcpServer, listMcpServersFor, toPublic } from '$lib/server/db/repo/mcp-servers.js';
import { canManageMcpServer, isAdminActor } from '$lib/server/mcp/access.js';
import { mcpServerCreateSchema } from '$lib/server/mcp/serverInput.js';
import type { RequestHandler } from './$types';

/** The servers the caller manages: their personal ones, plus the shared ones for admins. */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const servers = listMcpServersFor(getDb(), user.id).filter((row) =>
		canManageMcpServer(row, user)
	);
	return json({ servers: servers.map(toPublic) });
};

/**
 * Any user may add a personal server over HTTP or SSE. Only admins add stdio servers
 * (they run an arbitrary command on the host) and servers shared with everyone.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = mcpServerCreateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const admin = isAdminActor(user);
	if (!admin && parsed.data.transport === 'stdio') error(403, { message: 'Admin required' });
	const { personal, ...input } = parsed.data;
	try {
		const server = createMcpServer(getDb(), {
			...input,
			ownerUserId: !admin || personal ? user.id : null
		});
		return json({ server: toPublic(server) }, { status: 201 });
	} catch (e) {
		if (e instanceof Database.SqliteError && e.code.startsWith('SQLITE_CONSTRAINT')) {
			error(400, { message: 'A server with this name already exists' });
		}
		throw e;
	}
};
