import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.TZ = 'UTC';

const { createDatetimeServer } = await import('./datetime.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

async function callTool(name: string, args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createDatetimeServer();
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

describe('datetime server', () => {
	it('now returns ISO, timezone and human text in UTC', async () => {
		const res = await callTool('now', { tz: 'UTC' });
		expect(isErr(res)).toBe(false);
		const parsed = JSON.parse(resultText(res)) as {
			iso: string;
			timezone: string;
			human: string;
		};
		expect(Number.isNaN(Date.parse(parsed.iso))).toBe(false);
		expect(parsed.timezone).toBe('UTC');
		expect(parsed.human).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
	});

	it('get_timezone returns the configured TZ', async () => {
		const res = await callTool('get_timezone', {});
		expect(isErr(res)).toBe(false);
		expect(JSON.parse(resultText(res))).toEqual({ timezone: 'UTC' });
	});

	it('format renders a luxon format string', async () => {
		const res = await callTool('format', { iso: '2024-01-15T10:00:00', fmt: 'yyyy', tz: 'UTC' });
		expect(resultText(res)).toBe('2024');
	});

	it('convert shifts the offset between timezones', async () => {
		const res = await callTool('convert', {
			iso: '2024-06-15T12:00:00',
			fromTz: 'UTC',
			toTz: 'Europe/Berlin'
		});
		expect(isErr(res)).toBe(false);
		const parsed = JSON.parse(resultText(res)) as { iso: string; timezone: string };
		expect(parsed.timezone).toBe('Europe/Berlin');
		expect(parsed.iso).toContain('2024-06-15T14:00:00');
		expect(parsed.iso).toContain('+02:00');
	});

	it('now and convert include a clock widget payload', async () => {
		const now = JSON.parse(resultText(await callTool('now', { tz: 'Asia/Tokyo' }))) as {
			clock: unknown;
		};
		expect(now.clock).toEqual({ zones: [{ label: 'Tokyo', tz: 'Asia/Tokyo' }] });

		const conv = JSON.parse(
			resultText(
				await callTool('convert', {
					iso: '2024-06-15T15:00:00',
					fromTz: 'America/Los_Angeles',
					toTz: 'Europe/Berlin'
				})
			)
		) as { clock: unknown };
		expect(conv.clock).toEqual({
			at: '2024-06-15T22:00:00.000Z',
			convert: true,
			zones: [
				{ label: 'Los Angeles', tz: 'America/Los_Angeles' },
				{ label: 'Berlin', tz: 'Europe/Berlin' }
			]
		});
	});

	it('rejects invalid timezones and timestamps', async () => {
		expect(isErr(await callTool('now', { tz: 'Bogus/Zone' }))).toBe(true);
		expect(isErr(await callTool('format', { iso: 'not-a-date', fmt: 'yyyy', tz: 'UTC' }))).toBe(
			true
		);
		expect(
			isErr(await callTool('convert', { iso: '2024-06-15T12:00:00', fromTz: 'UTC', toTz: 'Nope' }))
		).toBe(true);
	});
});
