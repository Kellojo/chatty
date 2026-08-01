import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { convert, convertMany, getMeasureKind, type Unit } from 'convert';
import { conversions } from 'convert/conversions';
import { z } from 'zod';
import { err, text } from './shared.js';

const MEASURE_NAMES: Record<number, string> = {
	0: 'angle',
	1: 'area',
	2: 'data',
	3: 'energy',
	4: 'force',
	5: 'frequency',
	6: 'illuminance',
	7: 'length',
	8: 'luminance',
	9: 'luminous-intensity',
	10: 'mass',
	11: 'power',
	12: 'pressure',
	13: 'temperature',
	14: 'time',
	15: 'volume'
};

function measureName(kind: number): string {
	return MEASURE_NAMES[kind] ?? `unknown (${kind})`;
}

const MEASURE_ENUM = z.enum([
	'angle',
	'area',
	'data',
	'energy',
	'force',
	'frequency',
	'illuminance',
	'length',
	'luminance',
	'luminous-intensity',
	'mass',
	'power',
	'pressure',
	'temperature',
	'time',
	'volume'
]);

function num(n: number): string {
	if (Number.isInteger(n)) return String(n);
	return String(n);
}

function checkFinite(value: number): ReturnType<typeof err> | null {
	if (Number.isNaN(value)) return err('result is NaN');
	if (!Number.isFinite(value)) return err('result is not finite');
	return null;
}

function fmtResult(value: number): ReturnType<typeof text> | ReturnType<typeof err> {
	const bad = checkFinite(value);
	if (bad) return bad;
	return text(num(value));
}

function factorial(n: number): number {
	if (!Number.isInteger(n) || n < 0) return NaN;
	let out = 1;
	for (let i = 2; i <= n; i++) out *= i;
	return out;
}

function gcdTwo(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) {
		const t = y;
		y = x % y;
		x = t;
	}
	return x;
}

function lcmTwo(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return Math.abs(a / gcdTwo(a, b)) * Math.abs(b);
}

function mean(values: number[]): number {
	return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stdev(values: number[], sample: boolean): number {
	if (sample && values.length < 2) return NaN;
	const m = mean(values);
	const variance =
		values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - (sample ? 1 : 0));
	return Math.sqrt(variance);
}

export function createMathServer(): McpServer {
	const server = new McpServer({ name: 'ai-chat-math', version: '0.1.0' });

	server.registerTool(
		'add',
		{
			description: 'Add two numbers',
			inputSchema: { a: z.number(), b: z.number() }
		},
		async ({ a, b }) => fmtResult(a + b)
	);

	server.registerTool(
		'subtract',
		{
			description: 'Subtract b from a',
			inputSchema: { a: z.number(), b: z.number() }
		},
		async ({ a, b }) => fmtResult(a - b)
	);

	server.registerTool(
		'multiply',
		{
			description: 'Multiply two numbers',
			inputSchema: { a: z.number(), b: z.number() }
		},
		async ({ a, b }) => fmtResult(a * b)
	);

	server.registerTool(
		'divide',
		{
			description: 'Divide a by b',
			inputSchema: { a: z.number(), b: z.number() }
		},
		async ({ a, b }) => {
			if (b === 0) return err('division by zero');
			return fmtResult(a / b);
		}
	);

	server.registerTool(
		'power',
		{
			description: 'Raise a to the power of b',
			inputSchema: { base: z.number(), exponent: z.number() }
		},
		async ({ base, exponent }) => fmtResult(base ** exponent)
	);

	server.registerTool(
		'sqrt',
		{
			description: 'Square root of a non-negative number',
			inputSchema: { value: z.number().min(0) }
		},
		async ({ value }) => fmtResult(Math.sqrt(value))
	);

	server.registerTool(
		'abs',
		{
			description: 'Absolute value',
			inputSchema: { value: z.number() }
		},
		async ({ value }) => fmtResult(Math.abs(value))
	);

	server.registerTool(
		'round',
		{
			description: 'Round to the nearest integer, or to a given number of decimal places',
			inputSchema: {
				value: z.number(),
				places: z.number().int().min(0).max(20).optional()
			}
		},
		async ({ value, places }) => {
			if (places === undefined) return fmtResult(Math.round(value));
			const factor = 10 ** places;
			return fmtResult(Math.round(value * factor) / factor);
		}
	);

	server.registerTool(
		'floor',
		{
			description: 'Round down to the nearest integer',
			inputSchema: { value: z.number() }
		},
		async ({ value }) => fmtResult(Math.floor(value))
	);

	server.registerTool(
		'ceil',
		{
			description: 'Round up to the nearest integer',
			inputSchema: { value: z.number() }
		},
		async ({ value }) => fmtResult(Math.ceil(value))
	);

	server.registerTool(
		'modulo',
		{
			description: 'Remainder of a divided by b',
			inputSchema: { a: z.number(), b: z.number() }
		},
		async ({ a, b }) => {
			if (b === 0) return err('modulo by zero');
			return fmtResult(a % b);
		}
	);

	server.registerTool(
		'log',
		{
			description:
				'Logarithm of a positive number. Defaults to natural log; provide a base for log base b',
			inputSchema: {
				value: z.number().positive(),
				base: z.number().positive().optional()
			}
		},
		async ({ value, base }) => {
			if (base === undefined) return fmtResult(Math.log(value));
			if (base === 1) return err('log base cannot be 1');
			return fmtResult(Math.log(value) / Math.log(base));
		}
	);

	server.registerTool(
		'exp',
		{
			description: 'e raised to the given power',
			inputSchema: { value: z.number() }
		},
		async ({ value }) => fmtResult(Math.exp(value))
	);

	server.registerTool(
		'factorial',
		{
			description: 'Factorial of a non-negative integer',
			inputSchema: { value: z.number().int().min(0).max(170) }
		},
		async ({ value }) => fmtResult(factorial(value))
	);

	server.registerTool(
		'gcd',
		{
			description: 'Greatest common divisor of two or more integers',
			inputSchema: { values: z.array(z.number().int()).min(2) }
		},
		async ({ values }) => fmtResult(values.reduce(gcdTwo))
	);

	server.registerTool(
		'lcm',
		{
			description: 'Least common multiple of two or more integers',
			inputSchema: { values: z.array(z.number().int()).min(2) }
		},
		async ({ values }) => fmtResult(values.reduce(lcmTwo))
	);

	server.registerTool(
		'min',
		{
			description: 'Smallest of the given numbers',
			inputSchema: { values: z.array(z.number()).min(1) }
		},
		async ({ values }) => fmtResult(Math.min(...values))
	);

	server.registerTool(
		'max',
		{
			description: 'Largest of the given numbers',
			inputSchema: { values: z.array(z.number()).min(1) }
		},
		async ({ values }) => fmtResult(Math.max(...values))
	);

	server.registerTool(
		'sum',
		{
			description: 'Sum of a list of numbers',
			inputSchema: { values: z.array(z.number()).min(1) }
		},
		async ({ values }) => fmtResult(values.reduce((s, v) => s + v, 0))
	);

	server.registerTool(
		'mean',
		{
			description: 'Arithmetic mean of a list of numbers',
			inputSchema: { values: z.array(z.number()).min(1) }
		},
		async ({ values }) => fmtResult(mean(values))
	);

	server.registerTool(
		'median',
		{
			description: 'Median of a list of numbers',
			inputSchema: { values: z.array(z.number()).min(1) }
		},
		async ({ values }) => fmtResult(median(values))
	);

	server.registerTool(
		'stdev',
		{
			description:
				'Standard deviation of a list of numbers. Population by default; set sample=true for sample standard deviation',
			inputSchema: {
				values: z.array(z.number()).min(1),
				sample: z.boolean().optional()
			}
		},
		async ({ values, sample }) => fmtResult(stdev(values, sample === true))
	);

	server.registerTool(
		'percentage',
		{
			description: 'Compute what percent part is of whole, or the value of percent% of whole',
			inputSchema: {
				whole: z.number(),
				percent: z.number().optional(),
				part: z.number().optional()
			}
		},
		async ({ whole, percent, part }) => {
			if (percent !== undefined && part !== undefined) {
				return err('provide either percent or part, not both');
			}
			if (percent === undefined && part === undefined) {
				return err('provide either percent or part');
			}
			if (percent !== undefined) return fmtResult((percent / 100) * whole);
			if (whole === 0) return err('cannot compute percent of zero whole');
			return fmtResult(((part as number) / whole) * 100);
		}
	);

	server.registerTool(
		'convert_units',
		{
			description:
				'Convert a numeric value from one unit to another (length, mass, temperature, time, data, volume, etc.). Use list_units to discover valid unit strings.',
			inputSchema: {
				value: z.number(),
				from: z.string().describe('Source unit, e.g. "km", "mile", "C", "GB"'),
				to: z.string().describe('Target unit, e.g. "m", "ft", "F", "MB"')
			}
		},
		async ({ value, from, to }) => {
			const fromKind = getMeasureKind(from as Unit);
			const toKind = getMeasureKind(to as Unit);
			if (fromKind === undefined) return err(`unknown unit: "${from}"`);
			if (toKind === undefined) return err(`unknown unit: "${to}"`);
			if (fromKind !== toKind) {
				return err(
					`cannot convert between different measures: ${measureName(fromKind)} and ${measureName(toKind)}`
				);
			}
			try {
				return fmtResult(convert(value, from as Unit).to(to as Unit) as number);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		}
	);

	server.registerTool(
		'convert_many',
		{
			description:
				'Convert a compound quantity expression (e.g. "2h 30min", "5kg 200g") to a single unit. Use list_units to discover valid unit strings.',
			inputSchema: {
				expression: z.string().describe('Quantity expression, e.g. "2h 30min" or "5kg 200g"'),
				to: z.string().describe('Target unit, e.g. "min" or "g"')
			}
		},
		async ({ expression, to }) => {
			const toKind = getMeasureKind(to as Unit);
			if (toKind === undefined) return err(`unknown unit: "${to}"`);
			try {
				return fmtResult(convertMany(expression as never).to(to as Unit) as number);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		}
	);

	server.registerTool(
		'list_units',
		{
			description:
				'List units supported by convert_units and convert_many, optionally filtered by measure. Returns each unit with its full names and symbols.',
			inputSchema: {
				measure: MEASURE_ENUM.optional().describe('Limit results to a single measure')
			}
		},
		async ({ measure }) => {
			const out: Record<string, Array<{ names: string[]; symbols: string[] }>> = {};
			for (const [kind, def] of conversions) {
				const name = measureName(kind as number);
				if (measure !== undefined && name !== measure) continue;
				out[name] = def.units.map((u) => ({ names: [...u.names], symbols: [...u.symbols] }));
			}
			return text(JSON.stringify(out));
		}
	);

	return server;
}
