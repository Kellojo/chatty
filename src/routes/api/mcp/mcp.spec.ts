import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DATABASE_PATH = ':memory:';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createApiKey } = await import('$lib/server/db/repo/api-keys.js');
const { listMcpServers } = await import('$lib/server/db/repo/mcp-servers.js');
const gateway = await import('$lib/server/db/repo/mcp-gateway.js');
const { POST, GET } = await import('./+server.js');

const URL_ = 'http://localhost/api/mcp';

/** Routes the SDK client's requests straight into the endpoint. */
const routeFetch = async (input: string | URL | Request, init?: RequestInit) => {
	const request = new Request(input, init);
	return (request.method === 'POST' ? POST : GET)({ request, url: new URL(request.url) } as never);
};

async function connect(rawKey: string): Promise<Client> {
	const client = new Client({ name: 'test', version: '1.0.0' });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(URL_), {
			fetch: routeFetch,
			requestInit: { headers: { authorization: `Bearer ${rawKey}` } }
		})
	);
	return client;
}

function server(name: string) {
	const row = listMcpServers(getDb()).find((r) => r.name === name);
	if (!row) throw new Error(`no builtin ${name}`);
	return row;
}

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
			 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		)
		.run();
});

describe('MCP gateway', () => {
	it('rejects requests without a key or without the mcp:use scope', async () => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const anonymous = await POST({
			request: new Request(URL_, { method: 'POST', body }),
			url: new URL(URL_)
		} as never);
		expect(anonymous.status).toBe(401);

		const { rawKey } = await createApiKey(getDb(), {
			userId: 'u1',
			label: 'x',
			scopes: ['llm:invoke']
		});
		const scoped = await POST({
			request: new Request(URL_, {
				method: 'POST',
				body,
				headers: { authorization: `Bearer ${rawKey}` }
			}),
			url: new URL(URL_)
		} as never);
		expect(scoped.status).toBe(403);
	});

	it("serves only the key's tools and counts calls per key", async () => {
		const db = getDb();
		// Keep the test offline and quick: math only, and only two of its tools.
		const { row: key, rawKey } = await createApiKey(db, {
			userId: 'u1',
			label: 'claude',
			scopes: ['mcp:use'],
			mcpAccess: [{ serverId: server('math').id, tools: ['calculate', 'statistics'] }]
		});
		const client = await connect(rawKey);
		try {
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name).sort()).toEqual(['calculate', 'statistics']);
			expect(tools.find((t) => t.name === 'calculate')?.inputSchema.properties).toHaveProperty(
				'expression'
			);

			const result = await client.callTool({
				name: 'calculate',
				arguments: { expression: '6 * 7' }
			});
			expect(JSON.stringify(result.content)).toContain('42');

			// A tool of a granted server the key wasn't given is unknown to it.
			const withheld = await client.callTool({ name: 'convert_units', arguments: {} });
			expect(withheld.isError).toBe(true);
		} finally {
			await client.close();
		}

		const usage = gateway.getMcpGatewayUsage(db, 'u1');
		expect(usage.calls).toBe(1);
		expect(usage.byKey[key.id].calls).toBe(1);
		expect(usage.byServer[server('math').id].topTools).toEqual([{ tool: 'calculate', calls: 1 }]);
	});

	it('answers GET with 405 (stateless, no stream)', async () => {
		const res = await GET({ request: new Request(URL_) } as never);
		expect(res.status).toBe(405);
	});
});

describe('mcp-gateway access', () => {
	it('gives a key without saved access the default servers, all tools', () => {
		const db = getDb();
		const names = gateway.resolveMcpAccess(db, null).servers.map((r) => r.name);
		expect(names).toContain('memory');
		expect(names).toContain('chat-search');
		expect(names).not.toContain('fs');
		expect(names).not.toContain('code-exec');
		expect([...gateway.resolveMcpAccess(db, null).tools.values()].every((t) => t === null)).toBe(
			true
		);
	});

	it('skips servers that no longer exist', () => {
		const access = gateway.resolveMcpAccess(getDb(), [
			{ serverId: 'gone', tools: null },
			{ serverId: server('memory').id, tools: ['search_memory'] }
		]);
		expect(access.servers.map((r) => r.name)).toEqual(['memory']);
		expect(access.tools.get('memory')).toEqual(new Set(['search_memory']));
	});
});
