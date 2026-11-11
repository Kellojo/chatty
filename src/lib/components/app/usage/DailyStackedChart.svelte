<script lang="ts">
	import { BarChart } from 'layerchart';
	import * as Chart from '$lib/components/ui/chart/index.js';
	import { cn } from '$lib/utils.js';
	import { formatDayLong, formatDayShort } from './usage.js';

	let {
		rows,
		series: allSeries,
		valueFormat = (v: number) => v.toLocaleString(),
		axisFormat,
		emptyText = 'Nothing recorded in this period.',
		class: className = 'max-h-[240px] min-h-[240px]'
	}: {
		/** One row per day: `day` (YYYY-MM-DD) plus a numeric value per series key. */
		rows: Record<string, string | number>[];
		series: { key: string; label: string; color: string }[];
		/** Formats values on the y-axis and in the tooltip. */
		valueFormat?: (value: number) => string;
		/** Short format for y-axis labels; defaults to `valueFormat`. */
		axisFormat?: (value: number) => string;
		/** Shown instead of the chart when every value is zero (no fake 0–1 scale). */
		emptyText?: string;
		/** Height classes for the chart container. */
		class?: string;
	} = $props();

	// Series with nothing to draw in this view (e.g. unpriced providers on a value chart) stay
	// out of the chart and its legend.
	const series = $derived(
		allSeries.filter((s) => rows.some((row) => Number(row[s.key] ?? 0) !== 0))
	);
	const config = $derived(
		Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]))
	);
	const isEmpty = $derived(series.length === 0);
	const formatAxis = $derived(axisFormat ?? valueFormat);
	// Left padding sized to the widest y label (the top of the tallest stack), so it never clips.
	const padding = $derived.by(() => {
		const max = Math.max(
			0,
			...rows.map((row) => series.reduce((sum, s) => sum + Number(row[s.key] ?? 0), 0))
		);
		const widest = Math.max(formatAxis(max).length, formatAxis(max / 2).length);
		return {
			top: 4,
			right: 4,
			left: Math.max(24, Math.ceil(widest * 6.5) + 10),
			bottom: 20
		};
	});
	// Up to ~6 short labels (fewer on narrow screens, ~64px each), anchored on the last
	// day so "today" is always labelled.
	let width = $state(0);
	const ticks = $derived.by(() => {
		const maxLabels = width > 0 ? Math.max(2, Math.min(6, Math.floor(width / 64))) : 6;
		const step = Math.max(1, Math.ceil(rows.length / maxLabels));
		return rows.filter((_, i) => (rows.length - 1 - i) % step === 0).map((row) => String(row.day));
	});
</script>

{#if isEmpty}
	<p class="py-3 text-sm text-muted-foreground">{emptyText}</p>
{:else}
	<div bind:clientWidth={width}>
		<Chart.Container {config} class={cn('w-full', className)}>
			<BarChart
				data={rows}
				x="day"
				{series}
				seriesLayout="stack"
				legend={false}
				rule={false}
				{padding}
				props={{
					// No outline: with the default 1px stroke, zero-value days drew stubs that read as data.
					bars: { strokeWidth: 0 },
					xAxis: { ticks, format: (d: string) => formatDayShort(d) },
					yAxis: { format: (v: number) => formatAxis(v) }
				}}
			>
				{#snippet tooltip()}
					<Chart.Tooltip labelFormatter={(d: string) => formatDayLong(d)}>
						{#snippet formatter({ value, name, item })}
							<div class="flex w-full items-center gap-2">
								<span class="size-2.5 shrink-0 rounded-[2px]" style:background-color={item.color}
								></span>
								<span class="flex-1 text-muted-foreground">{name}</span>
								<span class="font-mono font-medium text-foreground tabular-nums">
									{valueFormat(Number(value))}
								</span>
							</div>
						{/snippet}
					</Chart.Tooltip>
				{/snippet}
			</BarChart>
		</Chart.Container>
	</div>
	<!-- Own legend: the chart's built-in one is a single centred row that clips long
	     model ids on narrow screens; this one wraps. -->
	{#if series.length >= 2}
		<ul class="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
			{#each series as s (s.key)}
				<li class="flex max-w-full min-w-0 items-center gap-1.5">
					<span class="size-2.5 shrink-0 rounded-[2px]" style:background-color={s.color}></span>
					<span class="truncate" title={s.label}>{s.label}</span>
				</li>
			{/each}
		</ul>
	{/if}
{/if}
