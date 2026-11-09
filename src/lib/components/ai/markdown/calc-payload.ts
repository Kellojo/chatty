/**
 * Payload parsing and number/unit formatting for the ```calc widget. The math
 * MCP tools (calculate, convert_units, convert_many, statistics) return these
 * shapes as JSON so the model can paste them verbatim into the fence.
 */

export type Quantity = { value: number; unit: string; name?: string };

export type CalcPayload =
	| { kind: 'calculate'; expression: string; result: number }
	| {
			kind: 'convert';
			measure?: string;
			from: { value?: number; unit?: string; name?: string; expression?: string };
			to: Quantity[];
	  }
	| {
			kind: 'statistics';
			count: number;
			sum: number | null;
			mean: number;
			median: number | null;
			q1: number | null;
			q3: number | null;
			min: number;
			max: number;
			stdev: number | null;
			variance: number | null;
			sample: boolean;
			values: number[] | null;
			histogram: number[] | null;
	  };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null);
const str = (v: unknown): string | undefined =>
	typeof v === 'string' && v.trim() ? v.trim() : undefined;

function quantity(v: unknown): Quantity | null {
	if (typeof v !== 'object' || v === null) return null;
	const q = v as Record<string, unknown>;
	if (!isNum(q.value)) return null;
	return { value: q.value, unit: str(q.unit) ?? '', name: str(q.name) };
}

export function parseCalc(code: string): CalcPayload | null {
	let raw: unknown;
	try {
		raw = JSON.parse(code);
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const d = raw as Record<string, unknown>;

	if (d.kind === 'calculate' || (d.kind === undefined && 'result' in d)) {
		if (!isNum(d.result)) return null;
		return { kind: 'calculate', expression: str(d.expression) ?? '', result: d.result };
	}

	if (d.kind === 'convert') {
		const targets = (Array.isArray(d.to) ? d.to : [d.to])
			.map(quantity)
			.filter((q): q is Quantity => q !== null);
		if (targets.length === 0) return null;
		const f = (typeof d.from === 'object' && d.from !== null ? d.from : {}) as Record<
			string,
			unknown
		>;
		return {
			kind: 'convert',
			measure: str(d.measure),
			from: {
				value: numOrNull(f.value) ?? undefined,
				unit: str(f.unit),
				name: str(f.name),
				expression: str(f.expression)
			},
			to: targets
		};
	}

	if (d.kind === 'statistics') {
		const values = Array.isArray(d.values) ? d.values.filter(isNum) : null;
		const histogram = Array.isArray(d.histogram)
			? d.histogram.map((n) => (isNum(n) && n > 0 ? n : 0))
			: null;
		const min = numOrNull(d.min) ?? (values?.length ? Math.min(...values) : null);
		const max = numOrNull(d.max) ?? (values?.length ? Math.max(...values) : null);
		const count = numOrNull(d.count) ?? values?.length ?? null;
		if (!isNum(d.mean) || min === null || max === null || count === null) return null;
		return {
			kind: 'statistics',
			count,
			sum: numOrNull(d.sum),
			mean: d.mean,
			median: numOrNull(d.median),
			q1: numOrNull(d.q1),
			q3: numOrNull(d.q3),
			min,
			max,
			stdev: numOrNull(d.stdev),
			variance: numOrNull(d.variance),
			sample: d.sample === true,
			values: values && values.length > 0 ? [...values].sort((a, b) => a - b) : null,
			histogram: histogram && histogram.some((n) => n > 0) ? histogram : null
		};
	}

	return null;
}

const SUPERSCRIPT: Record<string, string> = {
	'0': '⁰',
	'1': '¹',
	'2': '²',
	'3': '³',
	'4': '⁴',
	'5': '⁵',
	'6': '⁶',
	'7': '⁷',
	'8': '⁸',
	'9': '⁹',
	'-': '⁻'
};

/** Typographic minus (U+2212) in place of the hyphen Intl emits. */
const minus = (s: string) => s.replace(/-/g, '−');

export type Formatted = {
	/** Display text, e.g. "12,400", "7.70505", "1.23 × 10⁻⁹". */
	text: string;
	/** Scientific-notation parts, so the exponent can be styled separately. */
	sci?: { mantissa: string; exponent: string; power: string };
};

/**
 * Human number formatting: locale grouping, at most `sig` significant digits
 * (but never rounding away integer digits), typographic minus, and scientific
 * notation for very large or very small magnitudes.
 */
export function formatNumber(value: number, sig = 10, locale?: string): Formatted {
	if (!Number.isFinite(value)) return { text: '—' };
	if (value === 0) return { text: '0' };
	const abs = Math.abs(value);
	if (abs >= 1e15 || abs < 1e-6) {
		const [m, e] = value.toExponential(Math.min(sig, 6) - 1).split('e');
		const mantissa = minus(
			new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(Number(m))
		);
		const exponent = [...String(Number(e))].map((c) => SUPERSCRIPT[c] ?? c).join('');
		return {
			text: `${mantissa} × 10${exponent}`,
			sci: { mantissa, exponent, power: minus(String(Number(e))) }
		};
	}
	const intDigits = Math.max(1, Math.floor(Math.log10(abs)) + 1);
	const fraction = Math.max(0, Math.min(20, sig - intDigits));
	const text = new Intl.NumberFormat(locale, { maximumFractionDigits: fraction }).format(value);
	// Rounding can collapse a tiny value to 0 ("0.0000004" at sig 3) — fall back to scientific.
	if (/^-?0$/.test(text)) return formatNumber(value, sig, locale);
	return { text: minus(text) };
}

/**
 * One precision rule for a whole dataset: about `sig` significant digits at the
 * scale of its largest magnitude, so mean, median, quartiles and axis labels
 * all show the same number of decimals.
 */
export function formatScaled(value: number, scale: number, sig = 5, locale?: string): string {
	const s = Math.abs(scale);
	if (!Number.isFinite(value)) return '—';
	if (s >= 1e15 || (s > 0 && s < 1e-6)) return formatNumber(value, sig, locale).text;
	const intDigits = s >= 1 ? Math.floor(Math.log10(s)) + 1 : 1;
	const leadingZeros = s > 0 && s < 1 ? -Math.floor(Math.log10(s)) - 1 : 0;
	const fraction = Math.max(0, Math.min(20, sig - intDigits + leadingZeros));
	return minus(new Intl.NumberFormat(locale, { maximumFractionDigits: fraction }).format(value));
}

/** Compact form for axis labels and tiles: fewer digits, K/M/B for big magnitudes. */
export function formatCompact(value: number, locale?: string): string {
	if (!Number.isFinite(value)) return '—';
	const abs = Math.abs(value);
	if (abs >= 1e6 && abs < 1e15) {
		return minus(
			new Intl.NumberFormat(locale, { notation: 'compact', maximumSignificantDigits: 3 }).format(
				value
			)
		);
	}
	return formatNumber(value, 4, locale).text;
}

/** Nicer unit symbols: "C" -> "°C", "m2" -> "m²", "l" -> "L", "km/h" unchanged. */
export function prettyUnit(unit: string): string {
	const u = unit.trim();
	if (u === 'C' || u === 'F' || u === 'R') return `°${u}`;
	if (u === 'l') return 'L';
	if (u === 'deg') return '°';
	return u
		.replace(/([a-zA-Zμ])([23])(?![0-9])/g, (_, l: string, d: string) => l + SUPERSCRIPT[d])
		.replace(/\*/g, '⋅');
}

/** Units written flush against the number ("20°C", "90°") rather than after a space. */
export function unitIsFlush(unit: string): boolean {
	return unit.startsWith('°') || unit === '%' || unit === '′' || unit === '″';
}

/** Expression with calculator glyphs: × ÷ −, and ^ for power. */
export function prettyExpression(expr: string): string {
	return expr
		.replace(/\*\*/g, '^')
		.replace(/\*/g, '×')
		.replace(/\//g, '÷')
		.replace(
			/(\d)[eE]([+-]?\d+)/g,
			(_, d: string, e: string) =>
				`${d}×10${[...String(Number(e))].map((c) => SUPERSCRIPT[c] ?? c).join('')}`
		)
		.replace(/-/g, '−');
}

export function capitalize(s: string): string {
	return s ? s[0].toUpperCase() + s.slice(1) : s;
}
