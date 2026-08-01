import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { createMathServer } = await import('./math.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

async function callTool(name: string, args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createMathServer();
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

function resultNum(res: unknown): number {
	return Number(resultText(res));
}

function isErr(res: unknown): boolean {
	return (res as { isError?: boolean }).isError === true;
}

describe('math server', () => {
	it('adds, subtracts, multiplies and divides', async () => {
		expect(resultNum(await callTool('add', { a: 2, b: 3 }))).toBe(5);
		expect(resultNum(await callTool('subtract', { a: 2, b: 3 }))).toBe(-1);
		expect(resultNum(await callTool('multiply', { a: 2, b: 3 }))).toBe(6);
		expect(resultNum(await callTool('divide', { a: 7, b: 2 }))).toBe(3.5);
	});

	it('rejects division and modulo by zero', async () => {
		expect(isErr(await callTool('divide', { a: 1, b: 0 }))).toBe(true);
		expect(isErr(await callTool('modulo', { a: 1, b: 0 }))).toBe(true);
	});

	it('computes powers, roots and absolute values', async () => {
		expect(resultNum(await callTool('power', { base: 2, exponent: 10 }))).toBe(1024);
		expect(resultNum(await callTool('sqrt', { value: 9 }))).toBe(3);
		expect(resultNum(await callTool('abs', { value: -4.5 }))).toBe(4.5);
	});

	it('rounds, floors and ceils', async () => {
		expect(resultNum(await callTool('round', { value: 3.5 }))).toBe(4);
		expect(resultNum(await callTool('round', { value: 3.14159, places: 2 }))).toBe(3.14);
		expect(resultNum(await callTool('floor', { value: 3.9 }))).toBe(3);
		expect(resultNum(await callTool('ceil', { value: 3.1 }))).toBe(4);
	});

	it('computes modulo', async () => {
		expect(resultNum(await callTool('modulo', { a: 10, b: 3 }))).toBe(1);
	});

	it('computes logarithms and exponentials', async () => {
		expect(resultNum(await callTool('log', { value: Math.E }))).toBeCloseTo(1);
		expect(resultNum(await callTool('log', { value: 8, base: 2 }))).toBe(3);
		expect(resultNum(await callTool('exp', { value: 0 }))).toBe(1);
		expect(isErr(await callTool('log', { value: 8, base: 1 }))).toBe(true);
	});

	it('computes factorials', async () => {
		expect(resultNum(await callTool('factorial', { value: 5 }))).toBe(120);
		expect(resultNum(await callTool('factorial', { value: 0 }))).toBe(1);
	});

	it('computes gcd and lcm', async () => {
		expect(resultNum(await callTool('gcd', { values: [12, 18] }))).toBe(6);
		expect(resultNum(await callTool('gcd', { values: [12, 18, 30] }))).toBe(6);
		expect(resultNum(await callTool('lcm', { values: [4, 6] }))).toBe(12);
		expect(resultNum(await callTool('lcm', { values: [4, 6, 8] }))).toBe(24);
	});

	it('computes min, max and sum', async () => {
		expect(resultNum(await callTool('min', { values: [3, 1, 4] }))).toBe(1);
		expect(resultNum(await callTool('max', { values: [3, 1, 4] }))).toBe(4);
		expect(resultNum(await callTool('sum', { values: [3, 1, 4] }))).toBe(8);
	});

	it('computes statistics', async () => {
		expect(resultNum(await callTool('mean', { values: [1, 2, 3, 4] }))).toBe(2.5);
		expect(resultNum(await callTool('median', { values: [1, 2, 3, 4] }))).toBe(2.5);
		expect(resultNum(await callTool('median', { values: [1, 2, 3] }))).toBe(2);
		expect(resultNum(await callTool('stdev', { values: [2, 4, 4, 4, 5, 5, 7, 9] }))).toBe(2);
		expect(
			resultNum(await callTool('stdev', { values: [2, 4, 4, 4, 5, 5, 7, 9], sample: true }))
		).toBeCloseTo(2.13809, 4);
	});

	it('computes percentages both ways', async () => {
		expect(resultNum(await callTool('percentage', { whole: 200, percent: 15 }))).toBe(30);
		expect(resultNum(await callTool('percentage', { whole: 200, part: 30 }))).toBe(15);
		expect(isErr(await callTool('percentage', { whole: 200 }))).toBe(true);
		expect(isErr(await callTool('percentage', { whole: 200, percent: 15, part: 30 }))).toBe(true);
		expect(isErr(await callTool('percentage', { whole: 0, part: 30 }))).toBe(true);
	});

	it('rejects non-finite results', async () => {
		expect(isErr(await callTool('power', { base: 10, exponent: 1000 }))).toBe(true);
	});

	describe('unit conversion', () => {
		it('converts between units', async () => {
			expect(
				resultNum(await callTool('convert_units', { value: 5, from: 'km', to: 'miles' }))
			).toBeCloseTo(3.10686, 4);
			expect(
				resultNum(await callTool('convert_units', { value: 1, from: 'mile', to: 'km' }))
			).toBeCloseTo(1.60934, 4);
			expect(
				resultNum(await callTool('convert_units', { value: 0, from: 'C', to: 'F' }))
			).toBeCloseTo(32, 10);
			expect(resultNum(await callTool('convert_units', { value: 1, from: 'GB', to: 'MB' }))).toBe(
				1000
			);
		});

		it('rejects unknown units and cross-measure conversions', async () => {
			expect(isErr(await callTool('convert_units', { value: 1, from: 'foo', to: 'm' }))).toBe(true);
			expect(isErr(await callTool('convert_units', { value: 1, from: 'm', to: 'foo' }))).toBe(true);
			expect(isErr(await callTool('convert_units', { value: 1, from: 'km', to: 'kg' }))).toBe(true);
			const res = await callTool('convert_units', { value: 1, from: 'km', to: 'kg' });
			expect(resultText(res)).toContain('different measures');
		});

		it('converts compound expressions', async () => {
			expect(resultNum(await callTool('convert_many', { expression: '2h 30min', to: 'min' }))).toBe(
				150
			);
			expect(resultNum(await callTool('convert_many', { expression: '5kg 200g', to: 'g' }))).toBe(
				5200
			);
		});

		it('rejects garbage expressions and unknown target units', async () => {
			expect(isErr(await callTool('convert_many', { expression: 'garbage input', to: 'm' }))).toBe(
				true
			);
			expect(isErr(await callTool('convert_many', { expression: '5km', to: 'bogus' }))).toBe(true);
		});

		it('lists all units when no measure is given', async () => {
			const res = await callTool('list_units', {});
			expect(isErr(res)).toBe(false);
			const parsed = JSON.parse(resultText(res)) as Record<string, unknown>;
			expect(Object.keys(parsed)).toContain('length');
			expect(Object.keys(parsed)).toContain('mass');
			expect(Object.keys(parsed)).toContain('temperature');
		});

		it('lists units filtered by measure', async () => {
			const res = await callTool('list_units', { measure: 'length' });
			expect(isErr(res)).toBe(false);
			const parsed = JSON.parse(resultText(res)) as Record<
				string,
				Array<{ names: string[]; symbols: string[] }>
			>;
			expect(Object.keys(parsed)).toEqual(['length']);
			const allSymbols = parsed.length.flatMap((u) => u.symbols);
			expect(allSymbols).toContain('m');
			expect(allSymbols).toContain('ft');
		});
	});
});
