<script lang="ts">
	import { BarChart, LineChart, AreaChart, PieChart } from 'layerchart';
	import * as Chart from '$lib/components/ui/chart/index.js';
	import type { ChartConfig } from '$lib/components/ui/chart/index.js';
	import type { ChartPayload } from './chart-payload.js';

	// The chart itself, split out of chart-widget so layerchart loads only when
	// a chart actually renders.
	let { data }: { data: ChartPayload } = $props();

	const CHART_COLORS = [
		'var(--chart-1)',
		'var(--chart-2)',
		'var(--chart-3)',
		'var(--chart-4)',
		'var(--chart-5)'
	];

	// Transform labels + datasets into LayerChart's row shape:
	// [{ label: 'Jan', ds0: 10, ds1: 5 }, ...]
	const rows = $derived.by(() => {
		return data.labels.map((label, i) => {
			const row: Record<string, string | number> = { label };
			for (let d = 0; d < data.datasets.length; d++) {
				row[`ds${d}`] = data.datasets[d].data[i] ?? 0;
			}
			return row;
		});
	});

	const series = $derived.by(() => {
		return data.datasets.map((ds, i) => ({
			key: `ds${i}`,
			label: ds.label ?? `Series ${i + 1}`,
			color: CHART_COLORS[i % CHART_COLORS.length]
		}));
	});

	const chartConfig = $derived.by(() => {
		const cfg: ChartConfig = {};
		for (const s of series) {
			cfg[s.key] = { label: s.label, color: s.color };
		}
		return cfg;
	});

	// Pie uses a single dataset, one slice per label
	const pieRows = $derived.by(() => {
		if (data.type !== 'pie') return [];
		const ds = data.datasets[0];
		return data.labels.map((label, i) => ({
			key: label,
			label,
			value: ds.data[i] ?? 0,
			color: CHART_COLORS[i % CHART_COLORS.length]
		}));
	});

	const pieConfig = $derived.by(() => {
		const cfg: ChartConfig = {};
		for (const r of pieRows) {
			cfg[r.key] = { label: r.label, color: r.color };
		}
		return cfg;
	});

	const pieTotal = $derived(pieRows.reduce((sum, r) => sum + r.value, 0));
	const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
	const pct = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

	const showLegend = $derived(data.type === 'pie' ? pieRows.length > 1 : data.datasets.length > 1);
</script>

<div class="px-4 pt-4 pb-3">
	{#if data.type === 'pie'}
		<Chart.Container config={pieConfig} class="aspect-auto h-64 w-full">
			<PieChart
				data={pieRows}
				key="key"
				label="label"
				value="value"
				c="color"
				innerRadius={-28}
				cornerRadius={4}
				padAngle={0.01}
			>
				{#snippet tooltip()}
					<Chart.Tooltip />
				{/snippet}
			</PieChart>
		</Chart.Container>
		<!-- Values stay readable without hovering (touch), unlike the tooltip. -->
		<ul class="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs">
			{#each pieRows as r (r.key)}
				<li class="flex items-center gap-1.5">
					<span class="size-2.5 shrink-0 rounded-[3px]" style="background: {r.color}"></span>
					<span class="text-muted-foreground">{r.label}</span>
					<span class="font-medium tabular-nums">{fmt.format(r.value)}</span>
					{#if pieTotal > 0}
						<span class="text-muted-foreground tabular-nums">{pct.format(r.value / pieTotal)}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if data.type === 'bar'}
		<Chart.Container config={chartConfig} class="aspect-auto h-64 w-full">
			<BarChart
				data={rows}
				x="label"
				{series}
				seriesLayout="group"
				legend={showLegend}
				props={{ bars: { radius: 4, strokeWidth: 0 } }}
			>
				{#snippet tooltip()}
					<Chart.Tooltip />
				{/snippet}
			</BarChart>
		</Chart.Container>
	{:else if data.type === 'line'}
		<Chart.Container config={chartConfig} class="aspect-auto h-64 w-full">
			<LineChart
				data={rows}
				x="label"
				{series}
				legend={showLegend}
				points={rows.length <= 12}
				props={{ spline: { strokeWidth: 2 } }}
			>
				{#snippet tooltip()}
					<Chart.Tooltip />
				{/snippet}
			</LineChart>
		</Chart.Container>
	{:else}
		<Chart.Container config={chartConfig} class="aspect-auto h-64 w-full">
			<AreaChart
				data={rows}
				x="label"
				{series}
				legend={showLegend}
				props={{ area: { fillOpacity: 0.25, line: { strokeWidth: 2 } } }}
			>
				{#snippet tooltip()}
					<Chart.Tooltip />
				{/snippet}
			</AreaChart>
		</Chart.Container>
	{/if}
</div>
