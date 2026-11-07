const COUNT_UNITS = [
	{ value: 1e12, suffix: 'T' },
	{ value: 1e9, suffix: 'B' },
	{ value: 1e6, suffix: 'M' },
	{ value: 1e3, suffix: 'k' }
] as const;

/** Compact count: 843, 1.5k, 2.5M, 3.1B, 1.2T (one decimal, trailing .0 dropped). */
export function formatCount(n: number): string {
	if (!Number.isFinite(n)) return '—';
	const sign = n < 0 ? '-' : '';
	const abs = Math.abs(n);
	if (Math.round(abs) < 1000) return `${sign}${Math.round(abs)}`;
	// Pick the unit after rounding so 999_950 becomes "1M", not "1000k".
	for (let i = COUNT_UNITS.length - 1; i >= 0; i--) {
		const unit = COUNT_UNITS[i];
		const rounded = Math.round((abs / unit.value) * 10) / 10;
		if (rounded < 1000 || i === 0) return `${sign}${rounded}${unit.suffix}`;
	}
	return `${sign}${abs}`;
}

/** Precise cost of a single call: "$0", "$0.00042", "$1.23". */
export function formatCost(usd: number | null): string {
	if (usd == null) return '—';
	if (usd === 0) return '$0';
	if (usd < 0.01) return `$${usd.toFixed(5)}`;
	return `$${usd.toFixed(2)}`;
}

/** Aggregate money (totals, charts, tables): "$0", "<$0.01", "$12.34", "$1,234.56". */
export function formatSpend(usd: number | null): string {
	if (usd == null || !Number.isFinite(usd)) return '—';
	if (usd === 0) return '$0';
	const sign = usd < 0 ? '-' : '';
	const abs = Math.abs(usd);
	if (abs < 0.01) return `${sign}<$0.01`;
	return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Short money for chart axes: "$0", "$0.5", "$2.25", "$200", "$1.2k". */
export function formatSpendCompact(usd: number): string {
	if (!Number.isFinite(usd)) return '—';
	const sign = usd < 0 ? '-' : '';
	const abs = Math.abs(usd);
	if (abs >= 1000) return `${sign}$${formatCount(abs)}`;
	if (abs >= 10 || Number.isInteger(abs)) return `${sign}$${Math.round(abs)}`;
	return `${sign}$${Number(abs.toFixed(2))}`;
}

export function formatLatency(ms: number | null): string {
	if (ms == null) return '—';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)} s`;
	const m = Math.floor(s / 60);
	const remS = Math.round(s % 60);
	return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
}

export function formatTokens(input: number | null, output: number | null): string {
	if (input === null && output === null) return '—';
	return `${input === null ? '—' : input.toLocaleString()} / ${output === null ? '—' : output.toLocaleString()}`;
}

export function formatToken(n: number | null): string {
	return n == null ? '—' : n.toLocaleString();
}

export function formatDurationMs(ms: number | null): string {
	if (ms == null) return '—';
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const remS = Math.round(s % 60);
	return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
}

export function formatUsdPerMillion(value: number): string {
	return `$${Number(value.toPrecision(6))}`;
}

/** Compact running time for live timers: `42s`, `4m 05s`, `1h 12m`. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
