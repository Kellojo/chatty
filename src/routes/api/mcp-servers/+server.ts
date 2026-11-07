import { json, error } from '@sveltejs/kit';
import Database from 'better-sqlite3';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { createMcpServer, listMcpServers, toPublic } from '$lib/server/db/repo/mcp-servers.js';
import { mcpServerCreateSchema } from '$lib/server/mcp/serverInput.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json({ servers: listMcpServers(getDb()).map(toPublic) });
};

// Admin-only: stdio servers run an arbitrary command on the host.
export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const parsed = mcpServerCreateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	try {
		const server = createMcpServer(getDb(), parsed.data);
		return json({ server: toPublic(server) }, { status: 201 });
	} catch (e) {
		if (e instanceof Database.SqliteError && e.code.startsWith('SQLITE_CONSTRAINT')) {
			error(400, { message: 'A server with this name already exists' });
		}
		throw e;
	}
};
