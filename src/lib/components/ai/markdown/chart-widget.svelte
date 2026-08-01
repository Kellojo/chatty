<script lang="ts">
	import BarChartIcon from '@lucide/svelte/icons/bar-chart-3';
	import { BarChart, LineChart, AreaChart, PieChart } from 'layerchart';
	import * as Chart from '$lib/components/ui/chart/index.js';
	import type { ChartConfig } from '$lib/components/ui/chart/index.js';

	type ChartType = 'bar' | 'line' | 'area' | 'pie';

	type Dataset = {
		label?: string;
		data: number[];
	};

	type Payload = {
		type: ChartType;
		title?: string;
		labels: string[];
		datasets: Dataset[];
	};

	type Props = {
		code: string;
		isIncomplete: boolean;
	};

	let { code, isIncomplete }: Props = $props();

	const CHART_COLORS = [
		'var(--chart-1)',
		'var(--chart-2)',
		'var(--chart-3)',
		'var(--chart-4)',
		'var(--chart-5)'
	];

	const data = $derived.by((): Payload | null => {
		if (isIncomplete) return null;
		try {
			const parsed = JSON.parse(code) as Payload;
			if (typeof parsed !== 'object' || parsed === null) return null;
			if (!['bar', 'line', 'area', 'pie'].includes(parsed.type)) return null;
			if (!Array.isArray(parsed.labels) || !Array.isArray(parsed.datasets)) return null;
			if (parsed.datasets.length === 0) return null;
			for (const ds of parsed.datasets) {
				if (!Array.isArray(ds.data)) return null;
			}
			return parsed;
		} catch {
			return null;
		}
	});

	// Transform labels + datasets into LayerChart's row shape:
	// [{ label: 'Jan', ds0: 10, ds1: 5 }, ...]
	const rows = $derived.by(() => {
		if (!data) return [];
		return data.labels.map((label, i) => {
			const row: Record<string, string | number> = { label };
			for (let d = 0; d < data.datasets.length; d++) {
				row[`ds${d}`] = data.datasets[d].data[i] ?? 0;
			}
			return row;
		});
	});

	const series = $derived.by(() => {
		if (!data) return [];
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
		if (!data || data.type !== 'pie') return [];
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

	const showLegend = $derived(
		data !== null && (data.type === 'pie' ? pieRows.length > 1 : data.datasets.length > 1)
	);
</script>

<div class="my-4 w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm">
	{#if !data}
		<div class="flex items-center gap-3 p-4">
			<BarChartIcon class="size-5 animate-pulse text-muted-foreground" />
			<span class="text-sm text-muted-foreground">
				{isIncomplete ? 'Loading chart…' : 'Could not render chart'}
			</span>
		</div>
	{:else}
		{#if data.title}
			<div class="border-b border-border/60 px-4 py-2.5">
				<span class="text-sm font-medium text-foreground">{data.title}</span>
			</div>
		{/if}
		<div class="p-4">
			{#if data.type === 'pie'}
				<Chart.Container config={pieConfig} class="min-h-[200px] w-full">
					<PieChart
						data={pieRows}
						key="key"
						label="label"
						value="value"
						c="color"
						legend={showLegend}
					>
						{#snippet tooltip()}
							<Chart.Tooltip />
						{/snippet}
					</PieChart>
				</Chart.Container>
			{:else if data.type === 'bar'}
				<Chart.Container config={chartConfig} class="min-h-[200px] w-full">
					<BarChart data={rows} x="label" {series} seriesLayout="group" legend={showLegend}>
						{#snippet tooltip()}
							<Chart.Tooltip />
						{/snippet}
					</BarChart>
				</Chart.Container>
			{:else if data.type === 'line'}
				<Chart.Container config={chartConfig} class="min-h-[200px] w-full">
					<LineChart data={rows} x="label" {series} legend={showLegend}>
						{#snippet tooltip()}
							<Chart.Tooltip />
						{/snippet}
					</LineChart>
				</Chart.Container>
			{:else}
				<Chart.Container config={chartConfig} class="min-h-[200px] w-full">
					<AreaChart data={rows} x="label" {series} legend={showLegend}>
						{#snippet tooltip()}
							<Chart.Tooltip />
						{/snippet}
					</AreaChart>
				</Chart.Container>
			{/if}
		</div>
	{/if}
</div>
