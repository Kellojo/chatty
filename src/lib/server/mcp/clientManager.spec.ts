import { afterEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const { connectServer } = await import('./clientManager.js');
type McpServerRow = import('../db/repo/mcp-servers.js').McpServerRow;

// A tiny MCP server run as a child process (resolved from the repo's node_modules).
const STDIO_SERVER = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'stdio-test', version: '0.0.0' });
server.registerTool('ping', { description: 'Replies pong' }, async () => ({
	content: [{ type: 'text', text: 'pong' }]
}));
await server.connect(new StdioServerTransport());
`;

function stdioRow(command: string | null, args: string[]): McpServerRow {
	return {
		id: 'stdio-1',
		name: 'stdio-test',
		transport: 'stdio',
		command,
		args: JSON.stringify(args),
		url: null,
		token_enc: null,
		enabled: 1,
		builtin: 0,
		load_mode: 'always',
		auth: 'token',
		oauth_client_id: null,
		oauth_client_secret_enc: null,
		oauth_scope: null,
		oauth_client_info_enc: null
	};
}

const ctx = { userId: 'u1', role: 'admin', workspaceDir: null, documentsDir: '' };

afterEach(() => {
	vi.restoreAllMocks();
});

describe('connectServer (stdio)', () => {
	it('spawns the command, exposes its tools and terminates it on close', async () => {
		const startSpy = vi.spyOn(StdioClientTransport.prototype, 'start');
		const conn = await connectServer(
			stdioRow(process.execPath, ['--input-type=module', '-e', STDIO_SERVER]),
			ctx
		);
		const transport = startSpy.mock.contexts[0] as InstanceType<typeof StdioClientTransport>;
		const pid = transport.pid;
		let tools: Record<string, unknown>;
		try {
			tools = await conn.client.tools();
		} finally {
			await conn.close();
		}
		expect(Object.keys(tools)).toEqual(['ping']);
		expect(pid).toBeTypeOf('number');
		// Signal 0 only checks existence; it throws once the child is gone.
		expect(() => process.kill(pid!, 0)).toThrow();
	}, 20_000);

	it('closes the spawned process when the MCP handshake fails', async () => {
		const closeSpy = vi.spyOn(StdioClientTransport.prototype, 'close');
		// Exits immediately without speaking MCP.
		await expect(
			connectServer(stdioRow(process.execPath, ['-e', 'process.exit(0)']), ctx)
		).rejects.toThrow();
		expect(closeSpy).toHaveBeenCalled();
	}, 20_000);

	it('rejects a stdio row without a command', async () => {
		await expect(connectServer(stdioRow(null, []), ctx)).rejects.toThrow(/no command/);
	});
});
