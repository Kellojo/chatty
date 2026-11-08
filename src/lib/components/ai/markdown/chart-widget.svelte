<script lang="ts">
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import ChartLineIcon from '@lucide/svelte/icons/chart-line';
	import ChartAreaIcon from '@lucide/svelte/icons/chart-area';
	import ChartPieIcon from '@lucide/svelte/icons/chart-pie';
	import WidgetCard from './widget-card.svelte';
	import type { ChartPayload, ChartType } from './chart-payload.js';

	const TYPE_LABEL: Record<ChartType, string> = {
		bar: 'Bar chart',
		line: 'Line chart',
		area: 'Area chart',
		pie: 'Pie chart'
	};

	const TYPE_ICON: Record<ChartType, typeof ChartColumnIcon> = {
		bar: ChartColumnIcon,
		line: ChartLineIcon,
		area: ChartAreaIcon,
		pie: ChartPieIcon
	};

	type Props = {
		code: string;
		isIncomplete: boolean;
	};

	let { code, isIncomplete }: Props = $props();

	const data = $derived.by((): ChartPayload | null => {
		if (isIncomplete) return null;
		try {
			const parsed = JSON.parse(code) as ChartPayload;
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
</script>

<WidgetCard
	icon={data ? TYPE_ICON[data.type] : ChartColumnIcon}
	status={data ? 'ready' : isIncomplete ? 'loading' : 'error'}
	loadingLabel="Loading chart…"
	errorLabel="Could not render chart"
	skeletonClass="h-64"
	raw={code}
	title={data?.title ?? (data ? TYPE_LABEL[data.type] : null)}
>
	{#if data}
		<!-- layerchart is heavy; load it only once a chart is shown. -->
		{#await import('./chart-widget-chart.svelte')}
			<div class="h-64 animate-pulse px-4 pt-4 pb-3"></div>
		{:then { default: ChartView }}
			<ChartView {data} />
		{:catch}
			<p class="px-4 py-3 text-sm text-destructive">Could not load the chart.</p>
		{/await}
	{/if}
</WidgetCard>
