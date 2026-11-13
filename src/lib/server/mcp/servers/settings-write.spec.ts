import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.SETTINGS_MCP_WRITE = 'true';

const { createSettingsServer } = await import('./settings.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

async function callTool(name: string, args: Record<string, unknown>, role: string) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createSettingsServer({
		userId: 'u1',
		role,
		workspaceDir: null,
		documentsDir: ''
	});
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

describe('settings server (writes enabled)', () => {
	it('rejects update_setting for non-admin users', async () => {
		const res = await callTool('update_setting', { key: 'theme', value: 'light' }, 'user');
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('requires an admin');
	});

	it('rejects update_setting without a value', async () => {
		const res = await callTool('update_setting', { key: 'theme' }, 'admin');
		// Input validation stops it before an undefined reaches the NOT NULL column.
		expect(isErr(res)).toBe(true);
	});

	it('allows admins to update and read back a setting', async () => {
		const res = await callTool('update_setting', { key: 'theme', value: 'light' }, 'admin');
		expect(isErr(res)).toBe(false);
		const got = await callTool('get_setting', { key: 'theme' }, 'user');
		expect(JSON.parse(resultText(got))).toBe('light');
	});
});
