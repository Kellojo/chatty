import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { createWaitServer } = await import('./wait.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

async function callTool(name: string, args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createWaitServer();
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return await tool.execute(args, { toolCallId: 't1', messages: [] });
	} finally {
		await client.close();
		await server.close();
	}
}

function resultText(res: unknown): string {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	return r.content?.[0]?.text ?? '';
}

function isErr(res: unknown): boolean {
	return (res as { isError?: boolean }).isError === true;
}

describe('wait server', () => {
	it('waits the requested duration and returns the current time', async () => {
		const start = Date.now();
		const res = await callTool('wait', { seconds: 1 });
		const elapsed = Date.now() - start;
		expect(isErr(res)).toBe(false);
		expect(elapsed).toBeGreaterThanOrEqual(900);
		const parsed = JSON.parse(resultText(res)) as { waitedSeconds: number; currentTime: string };
		expect(parsed.waitedSeconds).toBeGreaterThanOrEqual(1);
		expect(Number.isNaN(Date.parse(parsed.currentTime))).toBe(false);
	});

	it('rejects zero and negative durations', async () => {
		expect(isErr(await callTool('wait', { seconds: 0 }))).toBe(true);
		expect(isErr(await callTool('wait', { seconds: -5 }))).toBe(true);
	});

	it('rejects durations above the maximum', async () => {
		expect(isErr(await callTool('wait', { seconds: 301 }))).toBe(true);
	});
});
