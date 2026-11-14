<script lang="ts" module>
	import type { SpeedStats } from '$lib/inference-speed.js';

	export type SpeedMetric = 'output' | 'input' | 'ttft';

	export interface SpeedRow {
		key: string;
		label: string;
		/** Smaller text under the label (e.g. the provider of a model). */
		sublabel?: string;
		color: string;
		stats: SpeedStats;
	}

	/** Fewer timed calls than this and a figure is marked as rough. */
	export const FEW_SAMPLES = 5;

	/** What a metric's samples are, singular and plural. */
	export const SAMPLE_NOUN: Record<SpeedMetric, [string, string]> = {
		output: ['timed reply', 'timed replies'],
		input: ['timed prompt', 'timed prompts'],
		ttft: ['call', 'calls']
	};

	export function metricValue(stats: SpeedStats, metric: SpeedMetric): number | null {
		return metric === 'output'
			? stats.outputTps
			: metric === 'input'
				? stats.inputTps
				: stats.ttftMs;
	}

	export function metricSamples(stats: SpeedStats, metric: SpeedMetric): number {
		return metric === 'output'
			? stats.outputSamples
			: metric === 'input'
				? stats.inputSamples
				: stats.samples;
	}
</script>

<script lang="ts">
	import { formatCount } from '$lib/formats.js';
	import {
		formatMs,
		formatTokensShort,
		formatTps,
		MIN_DECODE_TOKENS,
		MIN_PREFILL_TOKENS
	} from '$lib/inference-speed.js';

	let {
		rows,
		metric,
		reference,
		label
	}: {
		rows: SpeedRow[];
		metric: SpeedMetric;
		/**
		 * The figure every row is compared with (the tick and "x% faster"): the median over all
		 * calls, so a row is never judged against a list it is part of.
		 */
		reference: number | null;
		/** Accessible name of the list. */
		label: string;
	} = $props();

	const lowerIsBetter = $derived(metric === 'ttft');
	const format = (v: number | null) => (metric === 'ttft' ? formatMs(v) : formatTps(v));
	const unit = $derived(metric === 'ttft' ? '' : 'tok/s');

	// Rows with a figure, best first; rows without one go last, unranked.
	const ranked = $derived.by(() => {
		const withValue = rows
			.map((row) => ({ row, value: metricValue(row.stats, metric) }))
			.filter((r): r is { row: SpeedRow; value: number } => r.value != null)
			.sort((a, b) => (lowerIsBetter ? a.value - b.value : b.value - a.value));
		const without = rows.filter((row) => metricValue(row.stats, metric) == null);
		return { withValue, without };
	});
	const max = $derived(Math.max(0, ...ranked.withValue.map((r) => r.value)));
	const referencePct = $derived(
		reference != null && max > 0 ? (Math.min(reference, max) / max) * 100 : null
	);

	/** "38% faster", "20% slower" or "typical", relative to `reference`. */
	function relative(value: number): { text: string; tone: 'up' | 'down' | 'flat' } | null {
		if (reference == null || reference <= 0 || value <= 0) return null;
		// How many times faster this row is than the reference.
		const ratio = lowerIsBetter ? reference / value : value / reference;
		if (Math.abs(ratio - 1) < 0.05) return { text: 'typical', tone: 'flat' };
		if (ratio >= 2) return { text: `${ratio.toFixed(1)}× faster`, tone: 'up' };
		if (ratio > 1) return { text: `${Math.round((ratio - 1) * 100)}% faster`, tone: 'up' };
		if (ratio <= 0.5) return { text: `${(1 / ratio).toFixed(1)}× slower`, tone: 'down' };
		return { text: `${Math.round((1 - ratio) * 100)}% slower`, tone: 'down' };
	}

	/** Sublabel, the other figures, context and sample count, for the line under the label. */
	/**
	 * Two short lines under the label: what the figure rests on (context it ran at, sample
	 * count), then the row's other two figures.
	 */
	function detail(row: SpeedRow): { basis: string[]; others: string[] } {
		const { stats } = row;
		const basis: string[] = row.sublabel ? [row.sublabel] : [];
		// The context the figures were measured at: it moves speed a lot on small models.
		if (stats.contextTokens != null)
			basis.push(`median context ${formatTokensShort(stats.contextTokens)}`);
		// The count the figure (and "few samples") is based on, not every call.
		const n = metricSamples(stats, metric);
		basis.push(`${formatCount(n)} ${n === 1 ? SAMPLE_NOUN[metric][0] : SAMPLE_NOUN[metric][1]}`);
		const others: string[] = [];
		if (metric !== 'output' && stats.outputTps != null)
			others.push(`Output ${formatTps(stats.outputTps)} tok/s`);
		if (metric !== 'input' && stats.inputTps != null)
			others.push(`Input ${formatTps(stats.inputTps)} tok/s`);
		if (metric !== 'ttft' && stats.ttftMs != null)
			others.push(`First token ${formatMs(stats.ttftMs)}`);
		basis[0] = basis[0].charAt(0).toUpperCase() + basis[0].slice(1);
		return { basis, others };
	}

	const toneClass = {
		up: 'text-emerald-700 dark:text-emerald-400',
		down: 'text-amber-700 dark:text-amber-400',
		flat: 'text-muted-foreground'
	};
	/**
	 * Phones: name and figure on one line, the bar under them, the detail last.
	 * From md: name over detail on the left, bar in the middle, figure on the right.
	 */
	const rowGrid =
		'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b border-border/50 py-3 last:border-b-0 md:grid-cols-[minmax(0,19rem)_minmax(0,1fr)_7.5rem] md:gap-y-0.5';
</script>

{#snippet rowName(row: SpeedRow, muted: boolean)}
	<span class="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
		<span
			class="size-2.5 shrink-0 rounded-full {muted ? 'opacity-50' : ''}"
			style:background-color={row.color}
			aria-hidden="true"
		></span>
		<span
			class="truncate text-sm font-medium {muted ? 'text-muted-foreground' : ''}"
			title={row.label}>{row.label}</span
		>
	</span>
{/snippet}

{#snippet rowDetail(row: SpeedRow, rowStart: string)}
	{@const d = detail(row)}
	<span
		class="col-span-2 {rowStart} flex flex-col pl-4.5 text-xs text-muted-foreground md:col-span-1 md:col-start-1 md:row-start-2"
	>
		{#each [d.basis, d.others] as line, l (l)}
			{#if line.length > 0}
				<!-- Breaks only between segments, never inside one. -->
				<span>
					{#each line as segment, i (i)}{#if i > 0}<span class="mx-1.5" aria-hidden="true">·</span
							>{/if}<span class="whitespace-nowrap">{segment}</span>{/each}
				</span>
			{/if}
		{/each}
	</span>
{/snippet}

<ul class="flex flex-col" aria-label={label}>
	{#each ranked.withValue as { row, value } (row.key)}
		{@const rel = relative(value)}
		{@const few = metricSamples(row.stats, metric) < FEW_SAMPLES}
		{@const spreadTitle =
			metric === 'output' && row.stats.outputP10 != null && row.stats.outputP90 != null
				? `Most replies ran at ${formatTps(row.stats.outputP10)}–${formatTps(row.stats.outputP90)} tok/s (10th–90th percentile)`
				: undefined}
		<li class={rowGrid}>
			{@render rowName(row, false)}
			<!-- The bar: length is the figure on a shared scale; the tick is the median over all calls. -->
			<div
				class="relative col-span-2 row-start-2 h-2.5 rounded-full bg-muted md:col-span-1 md:col-start-2 md:row-span-2 md:row-start-1"
				aria-hidden="true"
			>
				<div
					class="absolute inset-y-0 left-0 rounded-full {few ? 'opacity-50' : ''}"
					style:width="{max > 0 ? Math.max(2, (value / max) * 100) : 0}%"
					style:background-color={row.color}
				></div>
				{#if referencePct != null}
					<div
						class="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
						style:left="{referencePct}%"
					></div>
				{/if}
			</div>
			<div
				class="col-start-2 row-start-1 flex flex-col items-end text-right md:col-start-3 md:row-span-2"
				title={spreadTitle}
			>
				<span class="text-sm font-semibold whitespace-nowrap tabular-nums">
					{format(value)}{#if unit}<span class="ml-0.5 text-xs font-normal text-muted-foreground"
							>{unit}</span
						>{/if}
				</span>
				{#if few}
					<!-- A rough figure makes no ranking claim. -->
					<span
						class="text-xs whitespace-nowrap text-muted-foreground"
						title="Based on fewer than {FEW_SAMPLES} {SAMPLE_NOUN[
							metric
						][1]}: too few to rank, so this is a rough figure"
					>
						few samples
					</span>
				{:else if rel}
					<span class="text-xs whitespace-nowrap {toneClass[rel.tone]}">
						{rel.text}{#if rel.tone !== 'flat'}<span class="sr-only"
								>&nbsp;than the median of all calls</span
							>{/if}
					</span>
				{/if}
			</div>
			{@render rowDetail(row, 'row-start-3')}
		</li>
	{/each}
	{#each ranked.without as row (row.key)}
		<li class={rowGrid}>
			{@render rowName(row, true)}
			<span
				class="col-start-2 row-start-1 text-right text-xs text-muted-foreground md:col-start-3 md:row-span-2"
				title={metric === 'input'
					? `No prompt had ${MIN_PREFILL_TOKENS}+ uncached tokens, too short to time prompt processing`
					: `No reply had ${MIN_DECODE_TOKENS}+ output tokens, too short to time generation`}
			>
				{metric === 'input' ? 'prompts too short' : 'replies too short'}
			</span>
			{@render rowDetail(row, 'row-start-2')}
		</li>
	{/each}
</ul>
