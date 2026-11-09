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

function checkFinite(value: number): ReturnType<typeof err> | null {
	if (Number.isNaN(value)) return err('result is NaN');
	if (!Number.isFinite(value)) return err('result is not finite');
	return null;
}

/** Trim binary float noise (0.1 + 0.2 -> 0.3) so the payload stays short and exact-looking. */
function clean(n: number): number {
	return Number.isFinite(n) ? Number(n.toPrecision(12)) : n;
}

/** The fence payload as tool output: JSON the model can paste verbatim into a ```calc block. */
function payload(data: Record<string, unknown>): ReturnType<typeof text> {
	return text(JSON.stringify(data));
}

type UnitInfo = { symbol: string; name: string; measure: string };

/** Every unit string `convert` accepts -> its display symbol, plural name and measure. */
const UNIT_INDEX: Map<string, UnitInfo> = (() => {
	const index = new Map<string, UnitInfo>();
	for (const [kind, def] of conversions) {
		const measure = measureName(kind as number);
		for (const u of def.units) {
			const names = [...u.names];
			const symbols = [...u.symbols];
			const singular = names[0] ?? symbols[0] ?? '';
			const plural =
				names.find((n) => n === `${singular}s` || n === `${singular}es`) ??
				(singular === 'foot' ? 'feet' : singular);
			// Prefer a typographic symbol (m², °C) when the library has one.
			const symbol = symbols.find((s) => /[°²³]/.test(s)) ?? symbols[0] ?? singular;
			const info = { symbol, name: plural, measure };
			for (const key of [...names, ...symbols]) if (!index.has(key)) index.set(key, info);
		}
	}
	return index;
})();

function unitInfo(unit: string): UnitInfo {
	return UNIT_INDEX.get(unit) ?? { symbol: unit, name: unit, measure: '' };
}

function quantity(value: number, unit: string): { value: number; unit: string; name: string } {
	const info = unitInfo(unit);
	return { value: clean(value), unit: info.symbol, name: info.name };
}

function mean(values: number[]): number {
	return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Linear-interpolated quantile of an ascending list (same as numpy's default). */
function quantile(sorted: number[], q: number): number {
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function variance(values: number[], sample: boolean): number {
	if (sample && values.length < 2) return NaN;
	const m = mean(values);
	return values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - (sample ? 1 : 0));
}

/** Up to this many values are returned raw (for a dot plot); larger sets as histogram counts. */
const MAX_RAW_VALUES = 60;
const HISTOGRAM_BINS = 24;

function histogram(sorted: number[], min: number, max: number): number[] {
	const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
	const span = max - min;
	for (const v of sorted) {
		const i =
			span === 0 ? Math.floor(HISTOGRAM_BINS / 2) : Math.floor(((v - min) / span) * HISTOGRAM_BINS);
		counts[Math.min(HISTOGRAM_BINS - 1, i)]++;
	}
	return counts;
}

const FENCE_HINT =
	'Returns JSON; to show it as a result card in chat, reply with a ```calc fenced code block containing that JSON verbatim.';

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
				'Percentages: "15% of 80" is 0.15 * 80. ' +
				FENCE_HINT,
			inputSchema: {
				expression: z.string().min(1).max(2000).describe('e.g. "(2^10 - 24) / sqrt(16)"')
			}
		},
		async ({ expression }) => {
			let result: number;
			try {
				result = evaluateExpression(expression);
			} catch (e) {
				if (e instanceof MathExprError) return err(e.message);
				throw e;
			}
			const bad = checkFinite(result);
			if (bad) return bad;
			return payload({ kind: 'calculate', expression: expression.trim(), result: clean(result) });
		}
	);

	server.registerTool(
		'statistics',
		{
			description:
				'Summary statistics of a list of numbers: count, sum, mean, median, quartiles, min, max, variance and standard deviation (population by default; sample=true for sample). ' +
				FENCE_HINT,
			inputSchema: {
				values: z.array(z.number()).min(1).max(100_000),
				sample: z.boolean().optional()
			}
		},
		async ({ values, sample }) => {
			const sorted = [...values].sort((a, b) => a - b);
			const min = sorted[0];
			const max = sorted[sorted.length - 1];
			const v = variance(values, sample === true);
			const stats: Record<string, unknown> = {
				kind: 'statistics',
				count: values.length,
				sum: clean(values.reduce((s, x) => s + x, 0)),
				mean: clean(mean(values)),
				median: clean(quantile(sorted, 0.5)),
				q1: clean(quantile(sorted, 0.25)),
				q3: clean(quantile(sorted, 0.75)),
				min,
				max,
				variance: Number.isFinite(v) ? clean(v) : null,
				stdev: Number.isFinite(v) ? clean(Math.sqrt(v)) : null,
				sample: sample === true
			};
			if (sorted.length <= MAX_RAW_VALUES) stats.values = sorted;
			else stats.histogram = histogram(sorted, min, max);
			return payload(stats);
		}
	);

	const targets = z
		.union([z.string(), z.array(z.string()).min(1).max(8)])
		.describe('Target unit, or up to 8 target units, e.g. "mi" or ["m", "ft", "yd"]');

	server.registerTool(
		'convert_units',
		{
			description:
				'Convert a numeric value from one unit to one or more others (length, mass, temperature, time, data, volume, etc.). Use list_units to discover valid unit strings. ' +
				FENCE_HINT,
			inputSchema: {
				value: z.number(),
				from: z.string().describe('Source unit, e.g. "km", "mile", "C", "GB"'),
				to: targets
			}
		},
		async ({ value, from, to }) => {
			const fromKind = getMeasureKind(from as Unit);
			if (fromKind === undefined) return err(`unknown unit: "${from}"`);
			const out = [];
			for (const unit of typeof to === 'string' ? [to] : to) {
				const toKind = getMeasureKind(unit as Unit);
				if (toKind === undefined) return err(`unknown unit: "${unit}"`);
				if (fromKind !== toKind) {
					return err(
						`cannot convert between different measures: ${measureName(fromKind)} and ${measureName(toKind)}`
					);
				}
				let result: number;
				try {
					result = convert(value, from as Unit).to(unit as Unit) as number;
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
				const bad = checkFinite(result);
				if (bad) return bad;
				out.push(quantity(result, unit));
			}
			return payload({
				kind: 'convert',
				measure: measureName(fromKind),
				from: quantity(value, from),
				to: out
			});
		}
	);

	server.registerTool(
		'convert_many',
		{
			description:
				'Convert a compound quantity expression (e.g. "2h 30min", "5kg 200g") to one or more units. Use list_units to discover valid unit strings. ' +
				FENCE_HINT,
			inputSchema: {
				expression: z.string().describe('Quantity expression, e.g. "2h 30min" or "5kg 200g"'),
				to: targets
			}
		},
		async ({ expression, to }) => {
			const out = [];
			let measure = '';
			for (const unit of typeof to === 'string' ? [to] : to) {
				const toKind = getMeasureKind(unit as Unit);
				if (toKind === undefined) return err(`unknown unit: "${unit}"`);
				let result: number;
				try {
					result = convertMany(expression as never).to(unit as Unit) as number;
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
				const bad = checkFinite(result);
				if (bad) return bad;
				measure = measureName(toKind);
				out.push(quantity(result, unit));
			}
			return payload({
				kind: 'convert',
				measure,
				from: { expression: expression.trim() },
				to: out
			});
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
