import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { BUILTIN_SERVERS } = await import('$lib/server/mcp/servers/index.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { TOOL_META } = await import('$lib/tool-meta.js');
const { BUILTIN_TOOL_EXAMPLES, buildDesignPlayground } = await import('./design-playground.js');

const ctx = {
	userId: 'playground',
	role: 'admin',
	workspaceDir: null,
	documentsDir: '/tmp/playground-docs'
};

async function listTools(server: string): Promise<string[]> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcp = BUILTIN_SERVERS[server](ctx);
	await mcp.connect(serverTransport);
	const client = new Client({ name: 'playground-spec', version: '0' });
	await client.connect(clientTransport);
	try {
		const { tools } = await client.listTools();
		return tools.map((t) => t.name);
	} finally {
		await client.close();
		await mcp.close();
	}
}

const registered = await Promise.all(
	Object.keys(BUILTIN_SERVERS).map(async (server) => ({ server, tools: await listTools(server) }))
);

describe('design playground', () => {
	it.each(registered)('has an example for every $server tool', ({ server, tools }) => {
		const examples = (BUILTIN_TOOL_EXAMPLES[server] ?? []).map((p) => p.toolName);
		expect(tools.filter((name) => !examples.includes(name))).toEqual([]);
	});

	it.each(registered)('labels every $server tool for the timeline', ({ server, tools }) => {
		expect(tools.filter((name) => TOOL_META[name]?.server !== server)).toEqual([]);
	});

	it('builds a conversation that alternates user turns and replies', () => {
		const messages = buildDesignPlayground();
		expect(messages.length).toBeGreaterThan(10);
		expect(messages[0].role).toBe('user');
		const toolCallIds = messages.flatMap((m) =>
			m.parts
				.map((p) => (p as { toolCallId?: string }).toolCallId)
				.filter((id): id is string => id !== undefined)
		);
		expect(new Set(toolCallIds).size).toBe(toolCallIds.length);
	});
});
