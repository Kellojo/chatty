import { afterEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const pool = await import('./pool.js');
type McpServerRow = import('../db/repo/mcp-servers.js').McpServerRow;

const STDIO_SERVER = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'stdio-test', version: '0.0.0' });
server.registerTool('ping', { description: 'Replies pong' }, async () => ({
	content: [{ type: 'text', text: 'pong' }]
}));
await server.connect(new StdioServerTransport());
`;

function row(overrides: Partial<McpServerRow> = {}): McpServerRow {
	return {
		id: 'stdio-1',
		name: 'stdio-test',
		transport: 'stdio',
		command: process.execPath,
		args: JSON.stringify(['--input-type=module', '-e', STDIO_SERVER]),
		url: null,
		token_enc: null,
		enabled: 1,
		builtin: 0,
		...overrides
	};
}

function isAlive(pid: number | null | undefined): boolean {
	try {
		process.kill(pid!, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
	const until = Date.now() + ms;
	while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
}

afterEach(async () => {
	await pool.closeAllMcpClients();
	vi.restoreAllMocks();
});

describe('MCP client pool', () => {
	it('reuses one connection across leases and closes it on shutdown', async () => {
		const startSpy = vi.spyOn(StdioClientTransport.prototype, 'start');
		const a = await pool.acquireMcpServer(row());
		const b = await pool.acquireMcpServer(row());
		expect(Object.keys(a.tools)).toEqual(['ping']);
		expect(b.tools).toBe(a.tools);
		expect(startSpy).toHaveBeenCalledTimes(1);
		a.release();
		b.release();
		const c = await pool.acquireMcpServer(row());
		c.release();
		expect(startSpy).toHaveBeenCalledTimes(1);
		const pid = (startSpy.mock.contexts[0] as InstanceType<typeof StdioClientTransport>).pid;
		expect(isAlive(pid)).toBe(true);
		await pool.closeAllMcpClients();
		expect(pool.pooledMcpClientCount()).toBe(0);
		await waitFor(() => !isAlive(pid));
		expect(isAlive(pid)).toBe(false);
	}, 30_000);

	it('shares one connect between concurrent acquires', async () => {
		const startSpy = vi.spyOn(StdioClientTransport.prototype, 'start');
		const leases = await Promise.all([1, 2, 3].map(() => pool.acquireMcpServer(row())));
		expect(startSpy).toHaveBeenCalledTimes(1);
		for (const lease of leases) lease.release();
	}, 30_000);

	it('opens a new connection when the server config changes', async () => {
		const startSpy = vi.spyOn(StdioClientTransport.prototype, 'start');
		(await pool.acquireMcpServer(row())).release();
		const edited = row({ args: JSON.stringify(['--input-type=module', '-e', STDIO_SERVER, 'x']) });
		expect(pool.poolKey(edited)).not.toBe(pool.poolKey(row()));
		(await pool.acquireMcpServer(edited)).release();
		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(pool.pooledMcpClientCount()).toBe(1);
	}, 30_000);

	it('invalidation closes idle connections and reconnects on next acquire', async () => {
		const startSpy = vi.spyOn(StdioClientTransport.prototype, 'start');
		(await pool.acquireMcpServer(row())).release();
		pool.invalidateMcpServer('stdio-1');
		expect(pool.pooledMcpClientCount()).toBe(0);
		(await pool.acquireMcpServer(row())).release();
		expect(startSpy).toHaveBeenCalledTimes(2);
	}, 30_000);

	it('keeps a leased connection open until released, even when evicted', async () => {
		const closeSpy = vi.spyOn(StdioClientTransport.prototype, 'close');
		const lease = await pool.acquireMcpServer(row());
		lease.markBroken();
		await new Promise((r) => setTimeout(r, 50));
		expect(closeSpy).not.toHaveBeenCalled();
		lease.release();
		await waitFor(() => closeSpy.mock.calls.length > 0);
		expect(closeSpy).toHaveBeenCalled();
	}, 30_000);

	it('closes idle connections in the sweep', async () => {
		(await pool.acquireMcpServer(row())).release();
		expect(pool.sweepIdleMcpClients(Date.now(), 60_000)).toBe(0);
		expect(pool.sweepIdleMcpClients(Date.now() + 120_000, 60_000)).toBe(1);
		expect(pool.pooledMcpClientCount()).toBe(0);
	}, 30_000);

	it('backs off after a failed connect instead of retrying every turn', async () => {
		const startSpy = vi.spyOn(StdioClientTransport.prototype, 'start');
		const dead = row({ id: 'dead', args: JSON.stringify(['-e', 'process.exit(0)']) });
		await expect(pool.acquireMcpServer(dead)).rejects.toThrow();
		await expect(pool.acquireMcpServer(dead)).rejects.toThrow();
		expect(startSpy).toHaveBeenCalledTimes(1);
		pool.invalidateMcpServer('dead');
		await expect(pool.acquireMcpServer(dead)).rejects.toThrow();
		expect(startSpy).toHaveBeenCalledTimes(2);
	}, 30_000);

	it('refuses builtin servers', async () => {
		await expect(pool.acquireMcpServer(row({ transport: 'builtin' }))).rejects.toThrow(
			/not pooled/
		);
	});
});
