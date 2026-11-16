import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.TZ = 'UTC';

const { createDatetimeServer, waitSeconds } = await import('./datetime.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
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
		expect(
			isErr(await callTool('convert', { iso: 'not-a-date', fromTz: 'UTC', toTz: 'UTC' }))
		).toBe(true);
		expect(
			isErr(await callTool('convert', { iso: '2024-06-15T12:00:00', fromTz: 'UTC', toTz: 'Nope' }))
		).toBe(true);
	});
});

/** Live timers in this process (the 300 s wait shows up here until it is cleared). */
function timerCount(): number {
	return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

describe('datetime wait tool', () => {
	it('no longer exposes format', async () => {
		await expect(callTool('format', { iso: '2024-01-15T10:00:00', fmt: 'yyyy' })).rejects.toThrow();
	});

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

	it('rejects zero, negative and too-long durations', async () => {
		expect(isErr(await callTool('wait', { seconds: 0 }))).toBe(true);
		expect(isErr(await callTool('wait', { seconds: -5 }))).toBe(true);
		expect(isErr(await callTool('wait', { seconds: 301 }))).toBe(true);
	});

	it('stops immediately with an error result when aborted', async () => {
		const ac = new AbortController();
		const start = Date.now();
		const pending = waitSeconds(300, ac.signal);
		setTimeout(() => ac.abort(), 20);
		const res = await pending;
		expect(Date.now() - start).toBeLessThan(1000);
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('cancelled');
		expect(isErr(await waitSeconds(300, AbortSignal.abort()))).toBe(true);
	});

	it('clears the server-side timer when the client cancels the call', async () => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = createDatetimeServer();
		await server.connect(serverTransport);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientTransport);
		try {
			const before = timerCount();
			const ac = new AbortController();
			const call = client.callTool({ name: 'wait', arguments: { seconds: 300 } }, undefined, {
				signal: ac.signal
			});
			await vi.waitFor(() => expect(timerCount()).toBeGreaterThan(before));
			ac.abort();
			await expect(call).rejects.toThrow();
			// The client sends notifications/cancelled; the handler's extra.signal clears its timer.
			await vi.waitFor(() => expect(timerCount()).toBeLessThanOrEqual(before));
		} finally {
			await client.close();
			await server.close();
		}
	});
});
