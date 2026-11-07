<script lang="ts">
	import { BarChart } from 'layerchart';
	import * as Chart from '$lib/components/ui/chart/index.js';
	import { cn } from '$lib/utils.js';
	import { formatDayLong, formatDayShort } from './usage.js';

	let {
		rows,
		series,
		valueFormat = (v: number) => v.toLocaleString(),
		emptyText = 'Nothing recorded in this period.',
		class: className = 'max-h-[240px] min-h-[240px]'
	}: {
		/** One row per day: `day` (YYYY-MM-DD) plus a numeric value per series key. */
		rows: Record<string, string | number>[];
		series: { key: string; label: string; color: string }[];
		/** Formats values on the y-axis and in the tooltip. */
		valueFormat?: (value: number) => string;
		/** Shown instead of the chart when every value is zero (no fake 0–1 scale). */
		emptyText?: string;
		/** Height classes for the chart container. */
		class?: string;
	} = $props();

	const config = $derived(
		Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]))
	);
	const isEmpty = $derived(!rows.some((row) => series.some((s) => Number(row[s.key] ?? 0) !== 0)));
	// ~6 short labels, anchored on the last day so "today" is always labelled.
	const ticks = $derived.by(() => {
		const step = Math.max(1, Math.ceil(rows.length / 6));
		return rows.filter((_, i) => (rows.length - 1 - i) % step === 0).map((row) => String(row.day));
	});
</script>

{#if isEmpty}
	<p class="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
{:else}
	<Chart.Container {config} class={cn('w-full', className)}>
		<BarChart
			data={rows}
			x="day"
			{series}
			seriesLayout="stack"
			legend={series.length >= 2}
			rule={false}
			props={{
				xAxis: { ticks, format: (d: string) => formatDayShort(d) },
				yAxis: { format: (v: number) => valueFormat(v) }
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
{/if}
