import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createMcpServer, getMcpServer } = await import('$lib/server/db/repo/mcp-servers.js');
const { GET, POST } = await import('./+server.js');
const { PATCH, DELETE } = await import('./[id]/+server.js');

type McpServerInfo = import('$lib/types.js').McpServerInfo;

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: {
		user: { id: string; role: string };
		params?: Record<string, string>;
		method?: 'GET' | 'DELETE';
		body?: unknown;
	}
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/mcp-servers');
	const method = init.method ?? (init.params ? 'PATCH' : 'POST');
	const event = {
		locals: { user: init.user, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, {
			method,
			...(init.method
				? {}
				: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) })
		}),
		url
	};
	try {
		const res = await handler(event as never);
		return { status: res.status, body: (await res.json()) as T };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body as T };
		throw e;
	}
}

const admin = { id: 'admin', role: 'admin' };
const user = { id: 'u1', role: 'user' };

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
			 ('admin', 'a@b.c', 'Admin', 0, 0, 0, 'admin'),
			 ('u1', 'd@e.f', 'One', 0, 0, 0, 'user'),
			 ('u2', 'g@h.i', 'Two', 0, 0, 0, 'user')`
		)
		.run();
});

describe('stdio MCP servers are admin-only', () => {
	it('forbids non-admins from creating a stdio server', async () => {
		const res = await call(POST, {
			user,
			body: { name: 'evil', transport: 'stdio', command: 'sh', args: ['-c', 'id'] }
		});
		expect(res.status).toBe(403);
		expect(
			getDb().prepare("SELECT COUNT(*) AS n FROM mcp_servers WHERE name = 'evil'").get()
		).toEqual({ n: 0 });
	});

	it('forbids non-admins from switching a server to stdio', async () => {
		const server = createMcpServer(getDb(), {
			name: 'remote',
			transport: 'http',
			url: 'https://mcp.example.com'
		});
		const res = await call(PATCH, {
			user,
			params: { id: server.id },
			body: { transport: 'stdio', command: 'sh' }
		});
		expect(res.status).toBe(403);
		expect(getMcpServer(getDb(), server.id)!.transport).toBe('http');
	});

	it('lets an admin create and edit a stdio server', async () => {
		const created = await call<{ server: McpServerInfo }>(POST, {
			user: admin,
			body: { name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }
		});
		expect(created.status).toBe(201);
		expect(created.body.server).toMatchObject({
			transport: 'stdio',
			command: 'npx',
			args: ['-y', 'pkg'],
			url: null
		});
		const patched = await call<{ server: McpServerInfo }>(PATCH, {
			user: admin,
			params: { id: created.body.server.id },
			body: { args: ['other'] }
		});
		expect(patched.status).toBe(200);
		expect(patched.body.server).toMatchObject({ command: 'npx', args: ['other'] });
	});

	it('rejects switching to stdio without a command', async () => {
		const server = createMcpServer(getDb(), {
			name: 'remote',
			transport: 'http',
			url: 'https://mcp.example.com'
		});
		const res = await call<{ message: string }>(PATCH, {
			user: admin,
			params: { id: server.id },
			body: { transport: 'stdio' }
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toContain('command');
	});
});

describe('personal MCP servers', () => {
	const other = { id: 'u2', role: 'user' };
	const remote = (name: string) => ({ name, transport: 'http', url: 'https://mcp.example.com' });

	it('lets any user add a remote server, which is only theirs', async () => {
		const res = await call<{ server: McpServerInfo }>(POST, {
			user,
			// Asking for a shared server changes nothing for a non-admin.
			body: { ...remote('mine'), personal: false }
		});
		expect(res.status).toBe(201);
		expect(res.body.server.personal).toBe(true);
		expect(getMcpServer(getDb(), res.body.server.id)!.owner_user_id).toBe('u1');
	});

	it('lets an admin choose between shared and only-me servers', async () => {
		const shared = await call<{ server: McpServerInfo }>(POST, {
			user: admin,
			body: remote('team')
		});
		const own = await call<{ server: McpServerInfo }>(POST, {
			user: admin,
			body: { ...remote('admins-own'), personal: true }
		});
		expect(getMcpServer(getDb(), shared.body.server.id)!.owner_user_id).toBeNull();
		expect(getMcpServer(getDb(), own.body.server.id)!.owner_user_id).toBe('admin');
	});

	it('lists only the servers the caller manages', async () => {
		const db = getDb();
		createMcpServer(db, { ...remote('team'), transport: 'http' });
		createMcpServer(db, { ...remote('ones'), transport: 'http', ownerUserId: 'u1' });
		createMcpServer(db, { ...remote('twos'), transport: 'http', ownerUserId: 'u2' });
		const names = async (who: { id: string; role: string }) =>
			(await call<{ servers: McpServerInfo[] }>(GET, { user: who, method: 'GET' })).body.servers
				.filter((s) => !s.builtin)
				.map((s) => s.name)
				.sort();
		expect(await names(user)).toEqual(['ones']);
		// Admins manage the shared servers and their own, never other users' personal ones.
		expect(await names(admin)).toEqual(['team']);
	});

	it("hides other users' personal servers, even from admins", async () => {
		const server = createMcpServer(getDb(), {
			...remote('ones'),
			transport: 'http',
			ownerUserId: 'u1'
		});
		for (const who of [other, admin]) {
			const patched = await call(PATCH, {
				user: who,
				params: { id: server.id },
				body: { url: 'https://evil.example' }
			});
			expect(patched.status).toBe(404);
			const deleted = await call(DELETE, {
				user: who,
				params: { id: server.id },
				method: 'DELETE'
			});
			expect(deleted.status).toBe(404);
		}
		expect(getMcpServer(getDb(), server.id)!.url).toBe('https://mcp.example.com');
	});

	it('lets the owner edit and delete their server, but never make it stdio', async () => {
		const server = createMcpServer(getDb(), {
			...remote('ones'),
			transport: 'http',
			ownerUserId: 'u1'
		});
		const stdio = await call(PATCH, {
			user,
			params: { id: server.id },
			body: { transport: 'stdio', command: 'sh' }
		});
		expect(stdio.status).toBe(403);
		const renamed = await call<{ server: McpServerInfo }>(PATCH, {
			user,
			params: { id: server.id },
			body: { name: 'renamed' }
		});
		expect(renamed.body.server.name).toBe('renamed');
		const deleted = await call(DELETE, { user, params: { id: server.id }, method: 'DELETE' });
		expect(deleted.status).toBe(200);
		expect(getMcpServer(getDb(), server.id)).toBeUndefined();
	});

	it('removes a user’s servers with the user', () => {
		const db = getDb();
		const server = createMcpServer(db, { ...remote('ones'), transport: 'http', ownerUserId: 'u1' });
		db.prepare('DELETE FROM "user" WHERE id = ?').run('u1');
		expect(getMcpServer(db, server.id)).toBeUndefined();
	});
});
