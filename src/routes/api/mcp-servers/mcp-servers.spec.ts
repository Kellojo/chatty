import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createMcpServer, getMcpServer } = await import('$lib/server/db/repo/mcp-servers.js');
const { POST } = await import('./+server.js');
const { PATCH } = await import('./[id]/+server.js');

type McpServerInfo = import('$lib/types.js').McpServerInfo;

async function call<T = unknown>(
	handler: (event: never) => Response | Promise<Response>,
	init: { user: { id: string; role: string }; params?: Record<string, string>; body: unknown }
): Promise<{ status: number; body: T }> {
	const url = new URL('http://localhost/api/mcp-servers');
	const event = {
		locals: { user: init.user, session: null } as unknown as App.Locals,
		params: init.params ?? {},
		request: new Request(url, {
			method: init.params ? 'PATCH' : 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(init.body)
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
