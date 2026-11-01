<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import FilterIcon from '@lucide/svelte/icons/filter';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import XCircleIcon from '@lucide/svelte/icons/x-circle';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import DollarSignIcon from '@lucide/svelte/icons/dollar-sign';
	import BarChart3Icon from '@lucide/svelte/icons/bar-chart-3';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import BracesIcon from '@lucide/svelte/icons/braces';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import { BarChart } from 'layerchart';
	import ActivityHistogram from '$lib/components/app/ActivityHistogram.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Chart from '$lib/components/ui/chart/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { formatDateTime, formatTimeAgo } from '$lib/datetime.js';
	import { formatCount, formatCost, formatLatency, formatTokens } from '$lib/formats.js';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import type { ProxyRequestStatus } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	onMount(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const off = onServerEvent((event) => {
			if (!event.type.startsWith('proxy.request.')) return;
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				void invalidateAll();
			}, 300);
		});
		return () => {
			off();
			if (timer) clearTimeout(timer);
		};
	});

	// Filter state (values from URL params, not two-way bound to Select)
	let searchValue = $state(data.filters.search);
	let sourceValue = $state(data.filters.source);
	let statusValue = $state(data.filters.status);
	let modelValue = $state(data.filters.model);
	let endpointValue = $state(data.filters.endpoint);
	let userValue = $state(data.filters.user);
	let fromValue = $state(data.filters.from);
	let toValue = $state(data.filters.to);

	$effect(() => {
		searchValue = data.filters.search;
		sourceValue = data.filters.source;
		statusValue = data.filters.status;
		modelValue = data.filters.model;
		endpointValue = data.filters.endpoint;
		userValue = data.filters.user;
		fromValue = data.filters.from;
		toValue = data.filters.to;
	});

	function filterUrl(updates: Record<string, string>): string {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(data.filters)) {
			if (value) params.set(key, value);
		}
		for (const [key, value] of Object.entries(updates)) {
			if (value) params.set(key, value);
			else params.delete(key);
		}
		params.delete('page');
		const qs = params.toString();
		return qs ? `${resolve('/requests')}?${qs}` : resolve('/requests');
	}

	function quickDateUrl(days: number): string {
		const to = new Date();
		const from = new Date();
		from.setDate(from.getDate() - days);
		return filterUrl({
			from: from.toISOString().slice(0, 10),
			to: to.toISOString().slice(0, 10)
		});
	}

	function pageHref(pageNum: number): string {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(data.filters)) {
			if (value) params.set(key, value);
		}
		if (pageNum > 1) params.set('page', String(pageNum));
		const qs = params.toString();
		return qs ? `${resolve('/requests')}?${qs}` : resolve('/requests');
	}

	function applySearch() {
		void goto(filterUrl({ search: searchValue }));
	}

	function applyDate() {
		void goto(filterUrl({ from: fromValue, to: toValue }));
	}

	function statusTone(status: ProxyRequestStatus): string {
		if (status === 'running') return 'border-info/40 text-info-foreground';
		if (status === 'complete') return 'border-success/30 text-success-foreground';
		return 'border-destructive/30 text-destructive';
	}

	function statusDot(status: ProxyRequestStatus): string {
		if (status === 'running') return 'bg-info animate-pulse';
		if (status === 'complete') return 'bg-success';
		return 'bg-destructive';
	}

	const successRate = $derived(
		data.stats.total > 0 ? `${Math.round((data.stats.completed / data.stats.total) * 100)}%` : '—'
	);

	const stats = $derived<{ label: string; value: string; icon: typeof ZapIcon; tone: string }[]>([
		{
			label: 'Requests',
			value: data.stats.total.toLocaleString(),
			icon: ZapIcon,
			tone: 'text-foreground'
		},
		{
			label: 'Success rate',
			value: successRate,
			icon: CheckCircle2Icon,
			tone: 'text-success'
		},
		{
			label: 'Avg latency',
			value: formatLatency(
				data.stats.avgLatencyMs !== null ? Math.round(data.stats.avgLatencyMs) : null
			),
			icon: ClockIcon,
			tone: 'text-amber-500'
		},
		{
			label: 'Tokens',
			value: formatCount(data.stats.inputTokens + data.stats.outputTokens),
			icon: TrendingUpIcon,
			tone: 'text-blue-500'
		},
		{
			label: 'Cost',
			value: formatCost(data.stats.costUsd),
			icon: DollarSignIcon,
			tone: 'text-violet-500'
		},
		{
			label: 'Failed',
			value: data.stats.failed.toLocaleString(),
			icon: XCircleIcon,
			tone: 'text-rose-500'
		},
		{
			label: 'Models',
			value: String(data.stats.distinctModels),
			icon: LayersIcon,
			tone: 'text-muted-foreground'
		},
		{
			label: 'Tokens saved',
			value: formatCount(data.stats.cavemanSaved),
			icon: BarChart3Icon,
			tone: 'text-orange-500'
		}
	]);

	const activeFilters = $derived.by(() => {
		const items: { key: string; label: string; value: string; clearUrl: string }[] = [];
		const f = data.filters;
		if (f.search)
			items.push({
				key: 'search',
				label: 'Search',
				value: f.search,
				clearUrl: filterUrl({ search: '' })
			});
		if (f.source)
			items.push({
				key: 'source',
				label: 'Source',
				value: f.source,
				clearUrl: filterUrl({ source: '' })
			});
		if (f.user) {
			const name = data.filterOptions.users.find((u) => u.id === f.user)?.name ?? f.user;
			items.push({ key: 'user', label: 'User', value: name, clearUrl: filterUrl({ user: '' }) });
		}
		if (f.key) {
			const label = data.filterOptions.keys.find((k) => k.id === f.key)?.label ?? f.key;
			items.push({ key: 'key', label: 'Key', value: label, clearUrl: filterUrl({ key: '' }) });
		}
		if (f.model)
			items.push({
				key: 'model',
				label: 'Model',
				value: f.model,
				clearUrl: filterUrl({ model: '' })
			});
		if (f.status)
			items.push({
				key: 'status',
				label: 'Status',
				value: f.status,
				clearUrl: filterUrl({ status: '' })
			});
		if (f.endpoint)
			items.push({
				key: 'endpoint',
				label: 'Endpoint',
				value: f.endpoint,
				clearUrl: filterUrl({ endpoint: '' })
			});
		if (f.from)
			items.push({ key: 'from', label: 'From', value: f.from, clearUrl: filterUrl({ from: '' }) });
		if (f.to) items.push({ key: 'to', label: 'To', value: f.to, clearUrl: filterUrl({ to: '' }) });
		return items;
	});

	const hasActiveFilters = $derived(activeFilters.length > 0);

	function sourceVariant(source: string): 'outline' | 'secondary' | 'default' {
		if (source === 'chat') return 'default';
		if (source === 'agent') return 'secondary';
		return 'outline';
	}

	const CHART_COLORS = [
		'var(--chart-1)',
		'var(--chart-2)',
		'var(--chart-3)',
		'var(--chart-4)',
		'var(--chart-5)',
		'var(--chart-other)'
	];

	const topSeries = $derived(
		data.stackedSeries.map((s, i) => ({
			...s,
			color:
				s.key === 'Other'
					? 'hsl(var(--muted-foreground) / 0.5)'
					: CHART_COLORS[i % CHART_COLORS.length]
		}))
	);

	const topChartConfig = $derived.by(() => {
		const cfg: Record<string, { label?: string; color?: string }> = {};
		for (const s of topSeries) {
			cfg[s.key] = { label: s.label, color: s.color };
		}
		return cfg;
	});

	const allTimeColorMap = $derived.by(() => {
		const map: Record<string, string> = {};
		for (const s of topSeries) {
			map[s.key] = s.color;
		}
		return map;
	});

	const allTimeRows = $derived.by(() => {
		if (data.topModels.length === 0) return [];
		const row: Record<string, string | number> = {};
		for (const m of data.topModels) {
			row[m.model] = m.count;
		}
		return [{ ...row, _x: '' }];
	});

	const allTimeSeries = $derived(
		data.topModels.map((m, i) => ({
			key: m.model,
			label: m.model,
			color: allTimeColorMap[m.model] ?? CHART_COLORS[i % CHART_COLORS.length]
		}))
	);

	const allTimeConfig = $derived.by(() => {
		const cfg: Record<string, { label?: string; color?: string }> = {};
		for (const s of allTimeSeries) {
			cfg[s.key] = { label: s.label, color: s.color };
		}
		return cfg;
	});
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
		<!-- Header -->
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-3">
				<div
					class="flex size-9 items-center justify-center rounded-xl border border-border/40 bg-card shadow-sm"
				>
					<ScrollTextIcon class="size-4.5 text-muted-foreground" />
				</div>
				<div class="flex flex-col">
					<h1 class="text-xl font-semibold tracking-tight">Requests</h1>
					<p class="text-sm text-muted-foreground">
						Monitor API traffic, usage and costs in real time
					</p>
				</div>
			</div>
			<div class="flex items-center gap-2">
				<span
					class="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground"
					title="Updates automatically as requests start and finish"
				>
					<span class="relative flex size-2">
						<span
							class="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60"
						></span>
						<span class="relative inline-flex size-2 rounded-full bg-success"></span>
					</span>
					Live
				</span>
				<Button
					variant="outline"
					size="sm"
					href={resolve('/requests')}
					disabled={!hasActiveFilters}
				>
					<XIcon class="size-3.5" />
					Clear filters
				</Button>
			</div>
		</div>

		<!-- Stats row -->
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			{#each stats as s (s.label)}
				<div
					class="rounded-2xl border border-border/40 bg-card px-4 py-3.5 transition-colors hover:border-border/70"
				>
					<div class="flex items-center justify-between gap-2">
						<span class="text-xs font-medium text-muted-foreground">{s.label}</span>
						<s.icon class="size-4 shrink-0 {s.tone}" />
					</div>
					<p class="mt-1.5 text-2xl leading-none font-semibold tracking-tight tabular-nums">
						{s.value}
					</p>
				</div>
			{/each}
		</div>

		<!-- Filter bar -->
		<div class="rounded-2xl border border-border/40 bg-card p-4">
			<div class="flex flex-wrap items-end gap-3">
				<!-- Search -->
				<div class="flex max-w-[360px] min-w-[220px] flex-1 flex-col gap-1.5">
					<Label for="filter-search">Search</Label>
					<div class="relative">
						<SearchIcon
							class="pointer-events-none absolute top-1/2 left-3 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							id="filter-search"
							placeholder="Model, endpoint, user..."
							class="pl-9"
							bind:value={searchValue}
							onkeydown={(e) => {
								if (e.key === 'Enter') applySearch();
							}}
						/>
					</div>
				</div>

				<!-- From date -->
				<div class="flex w-[150px] flex-col gap-1.5">
					<Label for="filter-from">From</Label>
					<Input id="filter-from" type="date" bind:value={fromValue} onchange={applyDate} />
				</div>

				<!-- To date -->
				<div class="flex w-[150px] flex-col gap-1.5">
					<Label for="filter-to">To</Label>
					<Input id="filter-to" type="date" bind:value={toValue} onchange={applyDate} />
				</div>

				<!-- Quick date presets -->
				<div class="flex flex-col gap-1.5">
					<span class="text-sm leading-none font-medium text-transparent select-none">Preset</span>
					<div
						class="flex h-9 items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5"
					>
						<Button
							variant="ghost"
							size="sm"
							class="h-7 px-2"
							href={filterUrl({ from: '', to: '' })}
						>
							All
						</Button>
						<Button variant="ghost" size="sm" class="h-7 px-2" href={quickDateUrl(1)}>Today</Button>
						<Button variant="ghost" size="sm" class="h-7 px-2" href={quickDateUrl(7)}>7d</Button>
						<Button variant="ghost" size="sm" class="h-7 px-2" href={quickDateUrl(30)}>30d</Button>
						<Button variant="ghost" size="sm" class="h-7 px-2" href={quickDateUrl(90)}>90d</Button>
					</div>
				</div>
			</div>

			<div class="mt-3 flex flex-wrap items-end gap-3 border-t border-border/40 pt-3">
				<!-- Source filter -->
				<div class="flex flex-col gap-1.5">
					<Label for="filter-source">Source</Label>
					<Select.Root
						type="single"
						value={sourceValue}
						onValueChange={(v) => {
							if (v !== undefined) void goto(filterUrl({ source: v }));
						}}
					>
						<Select.Trigger id="filter-source" class="w-[120px]">
							{#if sourceValue}
								{sourceValue.charAt(0).toUpperCase() + sourceValue.slice(1)}
							{:else}
								<span class="text-muted-foreground">All</span>
							{/if}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">All sources</Select.Item>
							{#each data.filterOptions.sources as source (source)}
								<Select.Item value={source}>
									{source.charAt(0).toUpperCase() + source.slice(1)}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<!-- Status filter -->
				<div class="flex flex-col gap-1.5">
					<Label for="filter-status">Status</Label>
					<Select.Root
						type="single"
						value={statusValue}
						onValueChange={(v) => {
							if (v !== undefined) void goto(filterUrl({ status: v }));
						}}
					>
						<Select.Trigger id="filter-status" class="w-[120px]">
							{#if statusValue}
								{statusValue.charAt(0).toUpperCase() + statusValue.slice(1)}
							{:else}
								<span class="text-muted-foreground">All</span>
							{/if}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">All statuses</Select.Item>
							{#each data.filterOptions.statuses as s (s)}
								<Select.Item value={s}>
									{s.charAt(0).toUpperCase() + s.slice(1)}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<!-- Model filter -->
				<div class="flex flex-col gap-1.5">
					<Label for="filter-model">Model</Label>
					<Select.Root
						type="single"
						value={modelValue}
						onValueChange={(v) => {
							if (v !== undefined) void goto(filterUrl({ model: v }));
						}}
					>
						<Select.Trigger id="filter-model" class="w-[180px]">
							{#if modelValue}
								{modelValue.length > 24 ? modelValue.slice(0, 24) + '...' : modelValue}
							{:else}
								<span class="text-muted-foreground">All</span>
							{/if}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">All models</Select.Item>
							{#each data.filterOptions.models as model (model)}
								<Select.Item value={model}>
									{model.length > 50 ? model.slice(0, 50) + '...' : model}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<!-- Endpoint filter -->
				<div class="flex flex-col gap-1.5">
					<Label for="filter-endpoint">Endpoint</Label>
					<Select.Root
						type="single"
						value={endpointValue}
						onValueChange={(v) => {
							if (v !== undefined) void goto(filterUrl({ endpoint: v }));
						}}
					>
						<Select.Trigger id="filter-endpoint" class="w-[170px]">
							{#if endpointValue}
								<span class="font-mono text-xs">{endpointValue}</span>
							{:else}
								<span class="text-muted-foreground">All</span>
							{/if}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">All endpoints</Select.Item>
							{#each data.filterOptions.endpoints as endpoint (endpoint)}
								<Select.Item value={endpoint}>{endpoint}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<!-- User filter -->
				<div class="flex flex-col gap-1.5">
					<Label for="filter-user">User</Label>
					<Select.Root
						type="single"
						value={userValue}
						onValueChange={(v) => {
							if (v !== undefined) void goto(filterUrl({ user: v }));
						}}
					>
						<Select.Trigger id="filter-user" class="w-[160px]">
							{#if userValue}
								{data.filterOptions.users.find((u) => u.id === userValue)?.name ?? userValue}
							{:else}
								<span class="text-muted-foreground">All</span>
							{/if}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">All users</Select.Item>
							{#each data.filterOptions.users as u (u.id)}
								<Select.Item value={u.id}>{u.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			</div>

			<!-- Active filter chips -->
			{#if hasActiveFilters}
				<div class="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
					<FilterIcon class="size-3.5 text-muted-foreground" />
					{#each activeFilters as chip (chip.key)}
						<Badge variant="secondary" class="gap-1.5 rounded-lg pr-1.5 font-normal">
							<span class="text-muted-foreground">{chip.label}:</span>
							{chip.value}
							<a
								href={chip.clearUrl}
								class="ml-0.5 rounded-md p-0.5 transition-colors hover:bg-muted"
								title="Remove {chip.label} filter"
							>
								<XIcon class="size-3" />
							</a>
						</Badge>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Activity + Charts section -->
		<div class="grid gap-4 lg:grid-cols-2">
			<Card.Root class="rounded-2xl border-border/40">
				<Card.Header class="pb-3">
					<Card.Title class="text-sm font-medium">Activity</Card.Title>
					<Card.Description>Daily request volume, last 365 days</Card.Description>
				</Card.Header>
				<Card.Content>
					<ActivityHistogram data={data.dailyCounts} />
				</Card.Content>
			</Card.Root>

			{#if data.stackedRows.length > 0}
				<Card.Root class="rounded-2xl border-border/40">
					<Card.Header class="pb-3">
						<Card.Title class="text-sm font-medium">Model usage</Card.Title>
						<Card.Description>Requests per model, past 7 days</Card.Description>
					</Card.Header>
					<Card.Content>
						<Chart.Container config={topChartConfig} class="max-h-[200px] min-h-[200px] w-full">
							<BarChart data={data.stackedRows} x="day" series={topSeries} seriesLayout="stack">
								{#snippet tooltip()}
									<Chart.Tooltip />
								{/snippet}
							</BarChart>
						</Chart.Container>
					</Card.Content>
				</Card.Root>
			{/if}
		</div>

		{#if data.topModels.length > 0}
			<Card.Root class="rounded-2xl border-border/40">
				<Card.Header class="pb-3">
					<Card.Title class="text-sm font-medium">All-time model distribution</Card.Title>
					<Card.Description>Total requests by model across all time</Card.Description>
				</Card.Header>
				<Card.Content>
					<Chart.Container config={allTimeConfig} class="max-h-[240px] min-h-[240px] w-full">
						<BarChart
							data={allTimeRows}
							x="_x"
							series={allTimeSeries}
							seriesLayout="group"
							legend={false}
						>
							{#snippet tooltip()}
								<Chart.Tooltip />
							{/snippet}
						</BarChart>
					</Chart.Container>
				</Card.Content>
			</Card.Root>
		{/if}

		<!-- Request log table -->
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Header class="flex flex-row items-center justify-between pb-3">
				<div class="flex flex-col gap-1">
					<Card.Title class="text-sm font-medium">Request log</Card.Title>
					<Card.Description>
						{#if data.totalResults > 0}
							Showing {(data.page - 1) * data.pageSize + 1}&ndash;{Math.min(
								data.page * data.pageSize,
								data.totalResults
							)} of {data.totalResults.toLocaleString()} request{data.totalResults !== 1 ? 's' : ''}
						{:else}
							No requests found
						{/if}
					</Card.Description>
				</div>
			</Card.Header>
			<Card.Content>
				<Table.Root>
					<Table.Header class="bg-muted/30">
						<Table.Row class="hover:bg-transparent">
							<Table.Head
								class="w-[150px] pl-4 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
							>
								Endpoint
							</Table.Head>
							<Table.Head
								class="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
							>
								Model
							</Table.Head>
							<Table.Head
								class="w-[90px] text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
							>
								Source
							</Table.Head>
							<Table.Head
								class="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
							>
								User / Key
							</Table.Head>
							<Table.Head
								class="w-[130px] text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
							>
								Status
							</Table.Head>
							<Table.Head
								class="w-[90px] text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
							>
								Started
							</Table.Head>
							<Table.Head
								class="w-[90px] text-right text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
							>
								Latency
							</Table.Head>
							<Table.Head
								class="w-[110px] text-right text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
							>
								Tokens
							</Table.Head>
							<Table.Head
								class="w-[90px] pr-4 text-right text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
							>
								Cost
							</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.requests as request (request.id)}
							<Table.Row
								class="group cursor-pointer transition-colors hover:bg-muted/40"
								onclick={() => goto(resolve(`/requests/${request.id}`))}
							>
								<Table.Cell class="pl-4">
									<span
										class="inline-flex items-center gap-1.5 font-mono text-xs text-foreground"
										title={request.endpoint}
									>
										<BracesIcon class="size-3 shrink-0 text-muted-foreground" />
										{request.endpoint}
									</span>
								</Table.Cell>
								<Table.Cell class="max-w-[220px]">
									<div class="flex flex-col gap-0.5">
										<span
											class="truncate text-sm font-medium group-hover:text-primary"
											title={request.requestedModel}
										>
											{request.requestedModel}
										</span>
										{#if request.modelId && request.modelId !== request.requestedModel}
											<span class="truncate text-xs text-muted-foreground" title={request.modelId}>
												{request.modelId}
												{#if request.fallbackIndex > 0}
													<Badge variant="outline" class="ml-1 text-[10px]">
														+{request.fallbackIndex}
													</Badge>
												{/if}
											</span>
										{:else if request.providerId}
											<span
												class="truncate text-xs text-muted-foreground"
												title={request.providerId}
											>
												{request.providerId}
											</span>
										{/if}
									</div>
								</Table.Cell>
								<Table.Cell>
									<Badge variant={sourceVariant(request.source)} class="capitalize">
										{request.source}
									</Badge>
								</Table.Cell>
								<Table.Cell class="max-w-[160px] text-muted-foreground">
									<div class="flex flex-col gap-0.5">
										<span class="truncate text-sm">
											{data.users[request.userId] ?? request.userId}
										</span>
										<span class="truncate text-xs">
											{request.apiKeyId ? (data.keys[request.apiKeyId] ?? request.apiKeyId) : '—'}
										</span>
									</div>
								</Table.Cell>
								<Table.Cell>
									<div class="flex items-center gap-2">
										<span
											class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium {statusTone(
												request.status
											)}"
										>
											<span class="size-1.5 rounded-full {statusDot(request.status)}"></span>
											{request.status}
										</span>
										{#if request.httpStatus !== null}
											<span
												class="font-mono text-xs text-muted-foreground tabular-nums"
												title="HTTP status"
											>
												{request.httpStatus}
											</span>
										{/if}
									</div>
								</Table.Cell>
								<Table.Cell class="text-sm whitespace-nowrap text-muted-foreground">
									<span title={formatDateTime(request.startedAt, data.timeFormat)}>
										{formatTimeAgo(request.startedAt)}
									</span>
								</Table.Cell>
								<Table.Cell class="text-right text-sm whitespace-nowrap text-muted-foreground">
									{formatLatency(request.latencyMs)}
								</Table.Cell>
								<Table.Cell
									class="text-right text-sm whitespace-nowrap text-muted-foreground tabular-nums"
									title="Input / output"
								>
									{formatTokens(request.inputTokens, request.outputTokens)}
								</Table.Cell>
								<Table.Cell class="pr-4 text-right text-sm whitespace-nowrap tabular-nums">
									{#if request.costUsd !== null}
										<span class={request.costUsd === 0 ? 'text-muted-foreground' : 'font-medium'}>
											{formatCost(request.costUsd)}
										</span>
									{:else}
										<span class="text-muted-foreground">—</span>
									{/if}
								</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row class="hover:bg-transparent">
								<Table.Cell colspan={9} class="py-14 text-center">
									<div class="flex flex-col items-center gap-2 text-muted-foreground">
										<InboxIcon class="size-6" />
										<span class="text-sm">
											{#if hasActiveFilters}
												No requests match your filters.
											{:else}
												No requests yet.
											{/if}
										</span>
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>

		<!-- Pagination -->
		{#if data.totalPages > 1}
			<div class="flex items-center justify-between">
				<p class="text-sm text-muted-foreground">
					Page {data.page} of {data.totalPages}
				</p>
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						href={pageHref(data.page - 1)}
						disabled={data.page <= 1}
					>
						<ChevronLeftIcon class="size-3.5" />
						Previous
					</Button>
					<Button
						variant="outline"
						size="sm"
						href={pageHref(data.page + 1)}
						disabled={data.page >= data.totalPages}
					>
						Next
						<ChevronRightIcon class="size-3.5" />
					</Button>
				</div>
			</div>
		{/if}
	</div>
</div>
