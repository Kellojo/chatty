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

/** The numeric answer from a calculate / convert payload (first target for conversions). */
function resultNum(res: unknown): number {
	const data = JSON.parse(resultText(res));
	return data.kind === 'convert' ? data.to[0].value : data.result;
}

function isErr(res: unknown): boolean {
	return (res as { isError?: boolean }).isError === true;
}

describe('math server', () => {
	const calc = async (expression: string) => callTool('calculate', { expression });

	it('evaluates arithmetic with precedence and parentheses', async () => {
		expect(resultNum(await calc('2 + 3 * 4'))).toBe(14);
		expect(resultNum(await calc('(2 + 3) * 4'))).toBe(20);
		expect(resultNum(await calc('7 / 2'))).toBe(3.5);
		expect(resultNum(await calc('10 % 3'))).toBe(1);
		expect(resultNum(await calc('2^10'))).toBe(1024);
		expect(resultNum(await calc('2**3**2'))).toBe(512);
		expect(resultNum(await calc('-2^2'))).toBe(-4);
		expect(resultNum(await calc('5!'))).toBe(120);
		expect(resultNum(await calc('1.5e3 + .5'))).toBe(1500.5);
	});

	it('supports functions and constants', async () => {
		expect(resultNum(await calc('sqrt(16) + abs(-4.5)'))).toBe(8.5);
		expect(resultNum(await calc('round(3.14159, 2)'))).toBe(3.14);
		expect(resultNum(await calc('floor(3.9) + ceil(3.1)'))).toBe(7);
		expect(resultNum(await calc('log(e)'))).toBeCloseTo(1);
		expect(resultNum(await calc('log(8, 2)'))).toBe(3);
		expect(resultNum(await calc('gcd(12, 18, 30) + lcm(4, 6, 8)'))).toBe(30);
		expect(resultNum(await calc('max(3, 1, 4) - min(3, 1, 4)'))).toBe(3);
		expect(resultNum(await calc('sin(pi / 2)'))).toBe(1);
		expect(resultNum(await calc('nCr(5, 2)'))).toBe(10);
	});

	it('rejects invalid expressions with a readable error', async () => {
		for (const bad of ['1 / 0', '1 % 0', '2 +', 'foo(1)', 'bar', '2 $ 3', '(1 + 2', 'sqrt(1, 2)']) {
			const res = await calc(bad);
			expect(isErr(res), bad).toBe(true);
		}
		expect(isErr(await calc('10^1000'))).toBe(true);
		// Overflows quickly instead of looping 5e14 times.
		expect(isErr(await calc('nCr(1e15, 5e14)'))).toBe(true);
		const nested = await calc(`${'('.repeat(900)}1${')'.repeat(900)}`);
		expect(resultText(nested)).toContain('nested too deeply');
		expect(resultNum(await calc(`${'('.repeat(50)}1${')'.repeat(50)}`))).toBe(1);
		expect(resultText(await calc('foo(1)'))).toContain('unknown function');
	});

	it('computes summary statistics', async () => {
		const stats = JSON.parse(
			resultText(await callTool('statistics', { values: [2, 4, 4, 4, 5, 5, 7, 9] }))
		);
		expect(stats).toMatchObject({
			count: 8,
			sum: 40,
			mean: 5,
			median: 4.5,
			min: 2,
			max: 9,
			stdev: 2
		});
		const sample = JSON.parse(
			resultText(await callTool('statistics', { values: [2, 4, 4, 4, 5, 5, 7, 9], sample: true }))
		);
		expect(sample.stdev).toBeCloseTo(2.138, 3);
		const single = JSON.parse(
			resultText(await callTool('statistics', { values: [3], sample: true }))
		);
		expect(single.stdev).toBeNull();
	});

	it('returns calc fence payloads', async () => {
		expect(JSON.parse(resultText(await calc(' 0.1 + 0.2 ')))).toEqual({
			kind: 'calculate',
			expression: '0.1 + 0.2',
			result: 0.3
		});
		const stats = JSON.parse(resultText(await callTool('statistics', { values: [3, 1, 2, 4] })));
		expect(stats).toMatchObject({ kind: 'statistics', q1: 1.75, q3: 3.25, sample: false });
		expect(stats.values).toEqual([1, 2, 3, 4]);
		expect(stats.histogram).toBeUndefined();
	});

	it('bins large samples into a histogram instead of echoing every value', async () => {
		const values = Array.from({ length: 500 }, (_, i) => i % 50);
		const stats = JSON.parse(resultText(await callTool('statistics', { values })));
		expect(stats.values).toBeUndefined();
		expect(stats.histogram).toHaveLength(24);
		expect(stats.histogram.reduce((s: number, n: number) => s + n, 0)).toBe(500);
		const same = JSON.parse(
			resultText(await callTool('statistics', { values: Array(100).fill(7) }))
		);
		expect(same.histogram.reduce((s: number, n: number) => s + n, 0)).toBe(100);
		expect(same.stdev).toBe(0);
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

		it('returns display symbols, names and several targets', async () => {
			const res = JSON.parse(
				resultText(
					await callTool('convert_units', { value: 12.4, from: 'km', to: ['miles', 'ft', 'm'] })
				)
			);
			expect(res.kind).toBe('convert');
			expect(res.measure).toBe('length');
			expect(res.from).toEqual({ value: 12.4, unit: 'km', name: 'kilometers' });
			expect(res.to.map((t: { unit: string }) => t.unit)).toEqual(['mi', 'ft', 'm']);
			expect(res.to[0].name).toBe('miles');
			expect(res.to[1].name).toBe('feet');
			expect(res.to[2].value).toBe(12400);
			const temp = JSON.parse(
				resultText(await callTool('convert_units', { value: 20, from: 'C', to: 'F' }))
			);
			expect(temp.from.unit).toBe('°C');
			expect(temp.to[0]).toEqual({ value: 68, unit: '°F', name: 'fahrenheit' });
			const many = JSON.parse(
				resultText(await callTool('convert_many', { expression: '2h 30min', to: ['min', 's'] }))
			);
			expect(many.from).toEqual({ expression: '2h 30min' });
			expect(many.measure).toBe('time');
			expect(many.to[1].value).toBe(9000);
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
