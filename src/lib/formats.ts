export function formatCount(n: number): string {
	if (n < 1000) return String(n);
	const format = (value: number, suffix: string) => {
		const rounded = Math.round(value * 10) / 10;
		return `${rounded}${suffix}`;
	};
	if (n < 1_000_000) return format(n / 1000, 'k');
	return format(n / 1_000_000, 'M');
}

export function formatCost(usd: number | null): string {
	if (usd == null) return '—';
	if (usd < 0.01) return `$${usd.toFixed(5)}`;
	return `$${usd.toFixed(2)}`;
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
