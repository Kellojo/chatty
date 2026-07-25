import { json, error } from '@sveltejs/kit';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { createMcpServer, listMcpServers, toPublic } from '$lib/server/db/repo/mcp-servers.js';
import type { RequestHandler } from './$types';

const createSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9-]*$/),
	transport: z.enum(['http', 'sse']),
	url: z.url(),
	token: z.string().min(1).nullish(),
	enabled: z.boolean().optional()
});

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json({ servers: listMcpServers(getDb()).map(toPublic) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
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
