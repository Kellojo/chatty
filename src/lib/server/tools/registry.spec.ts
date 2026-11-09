import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { getDb, closeDb } = await import('../db/index.js');
const { buildTools } = await import('./registry.js');
const repo = await import('../db/repo/mcp-servers.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const { closeAllMcpClients, sweepIdleMcpClients } = await import('../mcp/pool.js');

const STDIO_SERVER = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'stdio-test', version: '0.0.0' });
server.registerTool('ping', { description: 'Replies pong' }, async () => ({
	content: [{ type: 'text', text: 'pong' }]
}));
await server.connect(new StdioServerTransport());
`;

function seedUser(id: string, role: string) {
	getDb()
		.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, ?)'
		)
		.run(id, 'A', `${id}@example.com`, role);
}

describe('tools registry', () => {
	beforeEach(() => {
		closeDb();
		seedUser('u1', 'user');
	});

	afterEach(async () => {
		await closeAllMcpClients();
		vi.restoreAllMocks();
	});

	it('reuses external MCP connections across turns and users', async () => {
		seedUser('u2', 'user');
		repo.createMcpServer(getDb(), {
			name: 'stdio-test',
			transport: 'stdio',
			command: process.execPath,
			args: ['--input-type=module', '-e', STDIO_SERVER]
		});
		const startSpy = vi.spyOn(StdioClientTransport.prototype, 'start');
		const first = await buildTools({ userId: 'u1', memoryEnabled: true });
		expect(first.toolToServer.ping).toBe('stdio-test');
		await first.close();
		const second = await buildTools({ userId: 'u2', memoryEnabled: true });
		expect(Object.keys(second.tools)).toContain('ping');
		await second.close();
		expect(startSpy).toHaveBeenCalledTimes(1);
	}, 30_000);

	it('offers a known server without connecting and connects on the first call', async () => {
		repo.createMcpServer(getDb(), {
			name: 'stdio-lazy',
			transport: 'stdio',
			command: process.execPath,
			args: ['--input-type=module', '-e', STDIO_SERVER]
		});
		const startSpy = vi.spyOn(StdioClientTransport.prototype, 'start');
		const first = await buildTools({ userId: 'u1', memoryEnabled: true });
		await first.close();
		// The idle connection is closed; its tool list is remembered.
		expect(sweepIdleMcpClients(Date.now() + 1, 0)).toBe(1);

		const idle = await buildTools({ userId: 'u1', memoryEnabled: true });
		expect(idle.toolToServer.ping).toBe('stdio-lazy');
		await idle.close();
		expect(startSpy).toHaveBeenCalledTimes(1);

		const used = await buildTools({ userId: 'u1', memoryEnabled: true });
		const output = await used.tools.ping.execute!(
			{},
			{
				toolCallId: 't1',
				messages: [],
				context: {}
			}
		);
		expect(JSON.stringify(output)).toContain('pong');
		await used.close();
		expect(startSpy).toHaveBeenCalledTimes(2);
	}, 30_000);

	it('builds tools from all enabled builtin servers', async () => {
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		const names = Object.keys(built.tools);
		for (const expected of [
			'fetch',
			'now',
			'search_chats',
			'fs_read',
			'fs_ls',
			'get_setting',
			'search_memory',
			'create_concept',
			'code_exec',
			'generate_image'
		]) {
			expect(names).toContain(expected);
		}
		expect(built.toolToServer.now).toBe('datetime');
		expect(built.toolToServer.fs_ls).toBe('fs');
		expect(built.toolToServer.search_memory).toBe('memory');
		expect(built.toolToServer.code_exec).toBe('code-exec');
		expect(built.toolToServer.generate_image).toBe('image');
		await built.close();
	});

	it('skips disabled servers', async () => {
		repo.updateMcpServer(getDb(), 'builtin-fs', { enabled: false });
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		expect(Object.keys(built.tools)).not.toContain('fs_ls');
		expect(Object.keys(built.tools)).toContain('now');
		await built.close();
	});

	it('applies the agent allowlist', async () => {
		const built = await buildTools({
			userId: 'u1',
			memoryEnabled: true,
			agentAllowlist: ['now', 'fs_ls', 'nonexistent']
		});
		expect(Object.keys(built.tools).sort()).toEqual(['fs_ls', 'now']);
		await built.close();
	});

	it('defers the tools of on-demand servers, unless an allowlist picks the tools', async () => {
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		for (const name of [
			'calculate',
			'get_weather',
			'list_agents',
			'search_chats',
			'generate_image',
			'create_skill',
			'fs_rm',
			'delete_concept'
		]) {
			expect(built.deferred.has(name), name).toBe(true);
		}
		for (const name of [
			'now',
			'fs_ls',
			'fs_write',
			'fetch',
			'search_memory',
			'create_concept',
			'load_skill',
			'read_skill_reference',
			'code_exec'
		]) {
			expect(built.deferred.has(name), name).toBe(false);
		}
		await built.close();

		const allowed = await buildTools({
			userId: 'u1',
			memoryEnabled: true,
			agentAllowlist: ['calculate', 'now']
		});
		expect(allowed.deferred.size).toBe(0);
		await allowed.close();
	});

	it('loads a server up front once it is set to always load', async () => {
		repo.updateMcpServer(getDb(), 'builtin-math', { loadMode: 'always' });
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		expect(built.deferred.has('calculate')).toBe(false);
		expect(built.deferred.has('get_weather')).toBe(true);
		await built.close();
	});

	it('excludes memory tools when memoryEnabled=false', async () => {
		const built = await buildTools({ userId: 'u1', memoryEnabled: false });
		expect(Object.keys(built.tools)).toContain('now');
		expect(Object.keys(built.tools)).not.toContain('search_memory');
		await built.close();
	});

	it('skips unreachable remote servers without failing the build', async () => {
		repo.createMcpServer(getDb(), {
			name: 'dead-remote',
			transport: 'http',
			url: 'http://127.0.0.1:1/mcp'
		});
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		expect(Object.keys(built.tools)).toContain('now');
		await built.close();
	});

	it('connects multiple servers in parallel', async () => {
		repo.createMcpServer(getDb(), {
			name: 'remote-a',
			transport: 'http',
			url: 'http://127.0.0.1:1/mcp'
		});
		repo.createMcpServer(getDb(), {
			name: 'remote-b',
			transport: 'http',
			url: 'http://127.0.0.1:2/mcp'
		});
		const built = await buildTools({ userId: 'u1', memoryEnabled: true });
		expect(Object.keys(built.tools)).toContain('now');
		await built.close();
	});

	it('resolves tool collisions in row order (first-wins)', async () => {
		const built = await buildTools({ userId: 'u1', memoryEnabled: false });
		const collisionToolName = Object.keys(built.tools)[0];
		expect(collisionToolName).toBeDefined();
		const serverA = built.toolToServer[collisionToolName];
		expect(typeof serverA).toBe('string');
	});
});
