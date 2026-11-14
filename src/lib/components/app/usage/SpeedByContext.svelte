<script lang="ts" module>
	import type { ContextSpeedStats } from '$lib/inference-speed.js';

	export interface ContextRow {
		key: string;
		label: string;
		color: string;
		stats: ContextSpeedStats;
	}
</script>

<script lang="ts">
	import { formatCount } from '$lib/formats.js';
	import { CONTEXT_BUCKETS, formatMs, formatTps } from '$lib/inference-speed.js';
	import {
		FEW_SAMPLES,
		metricSamples,
		metricValue,
		SAMPLE_NOUN,
		type SpeedMetric
	} from './SpeedBars.svelte';

	let { rows: allRows, metric }: { rows: ContextRow[]; metric: SpeedMetric } = $props();

	/**
	 * Rows with a solid figure (enough samples) in some band; the rest are counted in a note
	 * under the table rather than shown as a row of rough guesses.
	 */
	const rows = $derived(
		allRows.filter((r) =>
			r.stats.byContext.some(
				(c) =>
					c != null && metricValue(c, metric) != null && metricSamples(c, metric) >= FEW_SAMPLES
			)
		)
	);
	/** What the cells hold, in words. */
	const cellMeaning = $derived(
		metric === 'ttft'
			? 'Median time to first token · lower is better'
			: `Median ${metric} speed in tok/s · higher is better`
	);
	const hiddenRows = $derived(allRows.length - rows.length);

	const lowerIsBetter = $derived(metric === 'ttft');
	const format = (v: number | null) => (metric === 'ttft' ? formatMs(v) : formatTps(v));

	/** Only bands some row has a figure for, so empty columns don't pad the table. */
	const bands = $derived(
		CONTEXT_BUCKETS.map((bucket, index) => ({ ...bucket, index })).filter((b) =>
			rows.some((r) => {
				const cell = r.stats.byContext[b.index];
				return cell != null && metricValue(cell, metric) != null;
			})
		)
	);

	function cells(row: ContextRow) {
		const values = bands.map((b) => {
			const stats = row.stats.byContext[b.index];
			const value = stats ? metricValue(stats, metric) : null;
			const samples = stats ? metricSamples(stats, metric) : 0;
			return { band: b, value, samples, few: samples < FEW_SAMPLES };
		});
		const best = Math.max(0, ...values.map((v) => v.value ?? 0));
		// Each cell's change against the model's shortest context with enough samples.
		const base = values.find((v) => v.value != null && !v.few) ?? null;
		const withChange = values.map((v) => {
			if (!base || v.value == null || v === base) return { ...v, vsBase: null, isBase: v === base };
			const ratio = v.value / base.value!;
			const worse = lowerIsBetter ? ratio > 1 : ratio < 1;
			return {
				...v,
				isBase: false,
				vsBase: {
					text: changeText(ratio),
					tone: !notable(ratio) ? 'flat' : worse ? 'worse' : 'better'
				}
			};
		});
		return { values: withChange, best };
	}

	/** "−45%", "+20%", or past 3× a multiplier ("67×"), which reads better than "+6644%". */
	function changeText(ratio: number): string {
		if (ratio >= 3) return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`;
		const pct = Math.round((ratio - 1) * 100);
		return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)}%`;
	}

	/** Changes under 15% stay neutral: within the usual run-to-run noise. */
	const notable = (ratio: number) => Math.abs(ratio - 1) >= 0.15;

	/**
	 * How the figure moves from the smallest to the largest context band that both have
	 * enough calls: "−45%" means output got 45% slower at long context.
	 */
	function change(row: ContextRow) {
		const solid = cells(row).values.filter((v) => v.value != null && !v.few);
		if (solid.length < 2) return null;
		const first = solid[0];
		const last = solid[solid.length - 1];
		const ratio = last.value! / first.value!;
		const pct = Math.round((ratio - 1) * 100);
		const worse = lowerIsBetter ? pct > 0 : pct < 0;
		return {
			pct,
			from: first,
			to: last,
			range: `${first.band.short} → ${last.band.short}`,
			text: changeText(ratio),
			worse: notable(ratio) && worse,
			better: notable(ratio) && !worse,
			title: `${format(first.value)} at ${first.band.label.toLowerCase()} → ${format(last.value)} at ${last.band.label.toLowerCase()} context`
		};
	}
	/** One plain sentence on the strongest context effect in view. */
	const takeaway = $derived.by(() => {
		let worst: { row: ContextRow; delta: NonNullable<ReturnType<typeof change>> } | null = null;
		for (const row of rows) {
			const delta = change(row);
			if (!delta?.worse) continue;
			const size = Math.abs(delta.pct);
			if (!worst || size > Math.abs(worst.delta.pct)) worst = { row, delta };
		}
		if (!worst) {
			return rows.some((r) => change(r) != null)
				? 'No model slows down noticeably as its context grows.'
				: null;
		}
		const { row, delta } = worst;
		return metric === 'ttft'
			? `Steepest slowdown: ${row.label} waits ${format(delta.from.value)} for its first token (${delta.from.band.label.toLowerCase()} context) and ${format(delta.to.value)} (${delta.to.band.label}), ${delta.text}.`
			: `Steepest drop: ${row.label} goes from ${format(delta.from.value)} tok/s (${delta.from.band.label.toLowerCase()} context) to ${format(delta.to.value)} tok/s (${delta.to.band.label}), ${delta.text}.`;
	});
</script>

{#if bands.length === 0}
	<p class="py-4 text-center text-sm text-muted-foreground">
		Not enough timed calls to split by context size yet.
	</p>
{:else}
	{#if takeaway}
		<p class="mb-3 rounded-lg bg-muted/60 px-3 py-2 text-sm">{takeaway}</p>
	{/if}
	<p class="mb-1 text-xs font-medium text-muted-foreground">
		{cellMeaning} · % against the model's shortest context ("base") · trend lines use each model's own
		scale
	</p>
	{#snippet deltaText(delta: ReturnType<typeof change>, inline = false)}
		{#if delta}
			<span
				title={delta.title}
				class={delta.worse
					? 'font-medium text-amber-700 dark:text-amber-400'
					: delta.better
						? 'font-medium text-emerald-700 dark:text-emerald-400'
						: 'text-muted-foreground'}>{delta.text}</span
			>
			<span
				class="{inline
					? 'ml-1'
					: 'block'} text-xs font-normal whitespace-nowrap text-muted-foreground"
				>{inline ? `(${delta.range})` : delta.range}</span
			>
			<span class="sr-only">({delta.title})</span>
		{:else}
			<span class="text-muted-foreground/70" title="Needs two context sizes with enough calls"
				>—</span
			>
		{/if}
	{/snippet}

	<!-- The context effect as a shape: the row's figures from short to long context, on the
	     row's own scale from zero. Hollow points rest on fewer than FEW_SAMPLES samples. -->
	{#snippet trend(values: ReturnType<typeof cells>['values'], best: number, color: string)}
		{@const points = values
			.map((v, i) => ({ ...v, i }))
			.filter((v) => v.value != null)
			.map((v) => ({
				x: values.length > 1 ? 4 + (v.i / (values.length - 1)) * 92 : 50,
				y: best > 0 ? 28 - (v.value! / best) * 24 : 28,
				few: v.few
			}))}
		<svg viewBox="0 0 100 32" class="h-8 w-20 shrink-0 overflow-visible" aria-hidden="true">
			<line x1="0" x2="100" y1="30" y2="30" class="stroke-border" stroke-width="1" />
			{#if points.length > 1}
				<polyline
					points={points.map((p) => `${p.x},${p.y}`).join(' ')}
					fill="none"
					stroke={color}
					stroke-width="2"
					stroke-linejoin="round"
					stroke-linecap="round"
					vector-effect="non-scaling-stroke"
				/>
			{/if}
			{#each points as p (p.x)}
				<circle
					cx={p.x}
					cy={p.y}
					r="3"
					fill={p.few ? 'var(--card)' : color}
					stroke={color}
					stroke-width="1.5"
					vector-effect="non-scaling-stroke"
				/>
			{/each}
		</svg>
	{/snippet}

	{#snippet cellBody(cell: ReturnType<typeof cells>['values'][number])}
		{#if cell.value == null}
			<span class="text-muted-foreground/70">—</span>
		{:else}
			<span class="flex flex-col items-end gap-0.5">
				<span
					class="whitespace-nowrap tabular-nums {cell.few
						? 'text-muted-foreground italic'
						: 'font-medium'}">{cell.few ? '~' : ''}{format(cell.value)}</span
				>
				<span class="text-xs leading-tight whitespace-nowrap tabular-nums">
					{#if cell.isBase}
						<span
							class="text-muted-foreground"
							title="The baseline the other context sizes compare with">base</span
						>
					{:else if cell.vsBase}
						<span
							class={cell.few
								? 'text-muted-foreground'
								: cell.vsBase.tone === 'worse'
									? 'text-amber-700 dark:text-amber-400'
									: cell.vsBase.tone === 'better'
										? 'text-emerald-700 dark:text-emerald-400'
										: 'text-muted-foreground'}>{cell.vsBase.text}</span
						><span class="sr-only"> vs the shortest context</span>
					{/if}
				</span>
				<span class="text-[11px] leading-none text-muted-foreground tabular-nums"
					>n={formatCount(cell.samples)}<span class="sr-only">
						{cell.samples === 1 ? SAMPLE_NOUN[metric][0] : SAMPLE_NOUN[metric][1]}</span
					></span
				>
			</span>
		{/if}
	{/snippet}

	<!-- Phones: one block per model with its bands side by side, so nothing scrolls away. -->
	<ul class="flex flex-col md:hidden" aria-label="Speed by context size">
		{#each rows as row (row.key)}
			{@const { values, best } = cells(row)}
			<li class="flex flex-col gap-2 border-b border-border/50 py-3 last:border-b-0">
				<div class="flex items-center gap-2 text-sm">
					<span
						class="size-2.5 shrink-0 rounded-full"
						style:background-color={row.color}
						aria-hidden="true"
					></span>
					<span class="min-w-0 flex-1 truncate font-medium" title={row.label}>{row.label}</span>
				</div>
				<div class="-mt-1 flex items-center justify-between gap-3 pl-4.5">
					<p class="text-xs tabular-nums">
						<span class="text-muted-foreground">Short → long:</span>
						{@render deltaText(change(row), true)}
					</p>
					{@render trend(values, best, row.color)}
				</div>
				<div
					class="grid gap-2 text-xs"
					style:grid-template-columns="repeat({bands.length}, minmax(0, 1fr))"
				>
					{#each values as cell (cell.band.index)}
						<div class="flex flex-col items-end gap-1">
							<span class="text-[11px] whitespace-nowrap text-muted-foreground"
								>{cell.band.label}</span
							>
							{@render cellBody(cell)}
						</div>
					{/each}
				</div>
			</li>
		{/each}
	</ul>

	<table class="hidden w-full border-collapse text-sm md:table">
		<caption class="sr-only">
			{metric === 'ttft' ? 'Time to first token' : metric === 'input' ? 'Input' : 'Output'}
			speed by context size
		</caption>
		<thead>
			<tr class="border-b border-border/60 text-xs text-muted-foreground">
				<th scope="col" class="py-2 pr-4 text-left font-medium"> Model </th>
				{#each bands as band (band.index)}
					<th scope="col" class="px-2 py-2 text-right font-medium whitespace-nowrap"
						>{band.label}</th
					>
				{/each}
				<th
					scope="col"
					class="py-2 pl-3 text-right font-medium whitespace-nowrap"
					title="From the shortest to the longest context with at least {FEW_SAMPLES} {SAMPLE_NOUN[
						metric
					][1]}"
				>
					Trend, short → long
				</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.key)}
				{@const { values, best } = cells(row)}
				<tr class="border-b border-border/50 last:border-b-0">
					<th scope="row" class="max-w-56 py-2.5 pr-4 text-left font-medium">
						<span class="flex min-w-0 items-center gap-2">
							<span
								class="size-2.5 shrink-0 rounded-full"
								style:background-color={row.color}
								aria-hidden="true"
							></span>
							<span class="truncate" title={row.label}>{row.label}</span>
						</span>
					</th>
					{#each values as cell (cell.band.index)}
						<td
							class="px-2 py-2.5 text-right align-middle"
							title={cell.value == null
								? 'No timed calls at this context size'
								: `${formatCount(cell.samples)} ${cell.samples === 1 ? SAMPLE_NOUN[metric][0] : SAMPLE_NOUN[metric][1]}${cell.few ? ' (rough figure)' : ''}`}
						>
							{@render cellBody(cell)}
						</td>
					{/each}
					<td class="py-2.5 pl-3 whitespace-nowrap tabular-nums">
						<span class="flex items-center justify-end gap-3">
							{@render trend(values, best, row.color)}
							<span class="w-20 text-right">{@render deltaText(change(row))}</span>
						</span>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<p class="mt-3 text-xs text-muted-foreground">
		Each cell: the {metric === 'ttft' ? 'median time to first token' : 'median speed'} and the number
		of {SAMPLE_NOUN[metric][1]} behind it (n). Faded figures and hollow points rest on fewer than {FEW_SAMPLES},
		so they are rough. Trend lines start at zero{metric === 'ttft'
			? '; a rising line means a longer wait'
			: '; a falling line means the model slows down'}.{hiddenRows > 0
			? ` ${hiddenRows} ${hiddenRows === 1 ? 'model is' : 'models are'} left out: no context size has ${FEW_SAMPLES}+ ${SAMPLE_NOUN[metric][1]} yet.`
			: ''}
	</p>
{/if}
