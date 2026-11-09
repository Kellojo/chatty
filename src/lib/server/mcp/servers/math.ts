import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { convert, convertMany, getMeasureKind, type Unit } from 'convert';
import { conversions } from 'convert/conversions';
import { z } from 'zod';
import { err, text } from './shared.js';
import { evaluateExpression, MATH_FUNCTION_NAMES, MathExprError } from './mathExpr.js';

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

function mean(values: number[]): number {
	return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function variance(values: number[], sample: boolean): number {
	if (sample && values.length < 2) return NaN;
	const m = mean(values);
	return values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - (sample ? 1 : 0));
}

export function createMathServer(): McpServer {
	const server = new McpServer({ name: 'ai-chat-math', version: '0.2.0' });

	server.registerTool(
		'calculate',
		{
			description:
				'Evaluate an arithmetic expression exactly. Operators: + - * / % (modulo) ^ or ** (power), ! (factorial), parentheses. ' +
				'Constants: pi, e, tau. Functions: ' +
				MATH_FUNCTION_NAMES.join(', ') +
				'. log(x) is natural log, log(x, base) any base; round(x, places); trig uses radians (deg()/rad() convert). ' +
				'Percentages: "15% of 80" is 0.15 * 80.',
			inputSchema: {
				expression: z.string().min(1).max(2000).describe('e.g. "(2^10 - 24) / sqrt(16)"')
			}
		},
		async ({ expression }) => {
			try {
				return fmtResult(evaluateExpression(expression));
			} catch (e) {
				if (e instanceof MathExprError) return err(e.message);
				throw e;
			}
		}
	);

	server.registerTool(
		'statistics',
		{
			description:
				'Summary statistics of a list of numbers: count, sum, mean, median, min, max, variance and standard deviation (population by default; sample=true for sample).',
			inputSchema: {
				values: z.array(z.number()).min(1),
				sample: z.boolean().optional()
			}
		},
		async ({ values, sample }) => {
			const v = variance(values, sample === true);
			const stats = {
				count: values.length,
				sum: values.reduce((s, x) => s + x, 0),
				mean: mean(values),
				median: median(values),
				min: Math.min(...values),
				max: Math.max(...values),
				variance: Number.isFinite(v) ? v : null,
				stdev: Number.isFinite(v) ? Math.sqrt(v) : null
			};
			return text(JSON.stringify(stats));
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
