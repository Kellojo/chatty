<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Popover } from 'bits-ui';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import FilterIcon from '@lucide/svelte/icons/filter';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import DollarSignIcon from '@lucide/svelte/icons/dollar-sign';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import BracesIcon from '@lucide/svelte/icons/braces';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import ActivityHistogram from '$lib/components/app/ActivityHistogram.svelte';
	import DailyStackedChart from '$lib/components/app/usage/DailyStackedChart.svelte';
	import { NO_COST_REPORTED, formatBilled, modelColors } from '$lib/components/app/usage/usage.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { formatDateTime, formatTimeAgo } from '$lib/datetime.js';
	import { formatCount, formatLatency, formatTokens } from '$lib/formats.js';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import type { ProxyRequestStatus } from '$lib/types.js';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import { resolveBrand } from '$lib/provider-brand.js';
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
	// Follows the URL, but stays editable until the search is applied.
	let searchValue = $derived(data.filters.search);
	let filtersOpen = $state(false);

	/** Requests page URL with the current filters, `updates` applied (empty value removes). */
	function requestsUrl(updates: Record<string, string>): string {
		const entries: Record<string, string> = { ...data.filters, ...updates };
		const query = Object.fromEntries(Object.entries(entries).filter(([, value]) => value));
		const qs = new URLSearchParams(query).toString();
		return qs ? `${resolve('/usage/requests')}?${qs}` : resolve('/usage/requests');
	}

	function filterUrl(updates: Record<string, string>): string {
		// Changing a filter always starts over at page 1.
		return requestsUrl({ ...updates, page: '' });
	}

	function pageHref(pageNum: number): string {
		return requestsUrl({ page: pageNum > 1 ? String(pageNum) : '' });
	}

	function navigate(url: string) {
		// URLs are built by requestsUrl() from resolve('/usage/requests').
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(url, { keepFocus: true, noScroll: true });
	}

	function applySearch() {
		navigate(filterUrl({ search: searchValue }));
	}

	function setFilter(key: string, value: string | undefined) {
		if (value !== undefined) navigate(filterUrl({ [key]: value }));
	}

	const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

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

	// ── scope: admins switch between everyone and themselves; others only ever see their own ──
	const scope = $derived(
		!data.isAdmin || data.filters.user === data.viewerId
			? 'me'
			: data.filters.user
				? 'user'
				: 'everyone'
	);
	const scopeUserName = $derived(
		data.filterOptions.users.find((u) => u.id === data.filters.user)?.name ?? data.filters.user
	);
	const scopeLabel = $derived(
		scope === 'me'
			? 'Your requests'
			: scope === 'user'
				? `Requests by ${scopeUserName}`
				: "Everyone's requests"
	);

	const successRate = $derived(
		data.stats.total > 0 ? `${Math.round((data.stats.completed / data.stats.total) * 100)}%` : '—'
	);

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
		if (f.provider) {
			const name =
				data.filterOptions.providers.find((p) => p.id === f.provider)?.name ?? f.provider;
			items.push({
				key: 'provider',
				label: 'Provider',
				value: name,
				clearUrl: filterUrl({ provider: '' })
			});
		}
		if (scope === 'user')
			items.push({
				key: 'user',
				label: 'User',
				value: scopeUserName,
				clearUrl: filterUrl({ user: '' })
			});
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
		return items;
	});

	const hasActiveFilters = $derived(activeFilters.length > 0);
	// Filters tucked behind the "Filters" button (on phones the inline selects move there too).
	const popoverOnlyCount = $derived(
		[data.filters.provider, data.filters.key, data.filters.endpoint].filter(Boolean).length +
			(scope === 'user' ? 1 : 0)
	);
	const inlineCount = $derived(
		[data.filters.model, data.filters.status, data.filters.source].filter(Boolean).length
	);
	const clearAllHref = $derived(
		filterUrl({
			search: '',
			source: '',
			provider: '',
			user: data.isAdmin && scope === 'me' ? data.viewerId : '',
			key: '',
			model: '',
			status: '',
			endpoint: ''
		})
	);

	// Quiet pills: the source is context, the status pill is what should stand out.
	function sourceVariant(source: string): 'outline' | 'secondary' {
		return source === 'agent' ? 'secondary' : 'outline';
	}

	/** A provider's display name; ids only as a fallback. */
	function providerName(id: string): string {
		return data.filterOptions.providers.find((p) => p.id === id)?.name ?? id;
	}

	// Color follows the model (its position among every model this viewer has used).
	const seriesColors = $derived(
		modelColors(
			data.stackedSeries.map((s) => s.key),
			data.filterOptions.models
		)
	);
	const topSeries = $derived(data.stackedSeries.map((s) => ({ ...s, color: seriesColors[s.key] })));
	const maxTopCount = $derived(Math.max(1, ...data.topModels.map((m) => m.count)));
</script>

<svelte:head><title>Requests · Usage · Chatty</title></svelte:head>

{#snippet modelSelect(triggerClass: string)}
	<Select.Root
		type="single"
		value={data.filters.model}
		onValueChange={(v) => setFilter('model', v)}
	>
		<Select.Trigger aria-label="Model" class={triggerClass}>
			{@const filterBrand = data.filters.model ? resolveBrand(data.filters.model) : null}
			<span class="flex min-w-0 items-center gap-1.5">
				{#if filterBrand}<ProviderIcon brand={filterBrand} class="size-3.5 shrink-0" />{/if}
				<span class="truncate {data.filters.model ? '' : 'text-muted-foreground'}">
					{data.filters.model || 'All models'}
				</span>
			</span>
		</Select.Trigger>
		<Select.Content>
			<Select.Item value="">All models</Select.Item>
			{#each data.filterOptions.models as model (model)}
				{@const brand = resolveBrand(model)}
				<Select.Item value={model} label={model}>
					{#if brand}<ProviderIcon {brand} class="size-3.5 shrink-0" />{/if}
					<span class="truncate">{model.length > 50 ? model.slice(0, 50) + '...' : model}</span>
				</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>
{/snippet}

{#snippet statusSelect(triggerClass: string)}
	<Select.Root
		type="single"
		value={data.filters.status}
		onValueChange={(v) => setFilter('status', v)}
	>
		<Select.Trigger aria-label="Status" class={triggerClass}>
			<span class={data.filters.status ? '' : 'text-muted-foreground'}>
				{data.filters.status ? capitalize(data.filters.status) : 'All statuses'}
			</span>
		</Select.Trigger>
		<Select.Content>
			<Select.Item value="">All statuses</Select.Item>
			{#each data.filterOptions.statuses as status (status)}
				<Select.Item value={status}>{capitalize(status)}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>
{/snippet}

{#snippet sourceSelect(triggerClass: string)}
	<Select.Root
		type="single"
		value={data.filters.source}
		onValueChange={(v) => setFilter('source', v)}
	>
		<Select.Trigger aria-label="Source" class={triggerClass}>
			<span class={data.filters.source ? '' : 'text-muted-foreground'}>
				{data.filters.source ? capitalize(data.filters.source) : 'All sources'}
			</span>
		</Select.Trigger>
		<Select.Content>
			<Select.Item value="">All sources</Select.Item>
			{#each data.filterOptions.sources as source (source)}
				<Select.Item value={source}>{capitalize(source)}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>
{/snippet}

<!-- hrefs below are built by requestsUrl()/filterUrl() from resolve('/usage/requests'). -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<div class="flex flex-col gap-6">
	<!-- Scope: what the numbers below count -->
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex min-w-0 flex-col gap-0.5">
			<h2 class="flex flex-wrap items-center gap-2 text-base font-semibold">
				{scopeLabel}
				<span
					class="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-xs font-medium text-muted-foreground"
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
			</h2>
			<p class="text-sm text-muted-foreground">
				Every model call — chat, agents and API keys — with usage and actual cost, {data.rangeLabel}.
			</p>
		</div>
		{#if data.isAdmin}
			<div class="flex rounded-lg border p-0.5" role="group" aria-label="Whose requests">
				{#each [{ value: 'everyone', label: 'Everyone', user: '' }, { value: 'me', label: 'Me', user: data.viewerId }] as option (option.value)}
					<a
						href={filterUrl({ user: option.user })}
						aria-current={scope === option.value ? 'true' : undefined}
						data-sveltekit-noscroll
						class="flex h-10 items-center rounded-md px-3 text-xs md:h-7 {scope === option.value
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:text-foreground'}"
					>
						{option.label}
					</a>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Filter bar: drives the stats, chart and the log alike -->
	<div class="flex flex-col gap-3">
		<div class="flex items-center gap-2 sm:flex-wrap">
			<div class="relative min-w-0 flex-1 sm:basis-56">
				<SearchIcon
					class="pointer-events-none absolute top-1/2 left-3 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					aria-label="Search requests"
					placeholder="Search model, endpoint, provider, error…"
					class="pl-9"
					bind:value={searchValue}
					onkeydown={(e) => {
						if (e.key === 'Enter') applySearch();
					}}
				/>
			</div>

			<div class="hidden items-center gap-2 sm:flex">
				{@render modelSelect('w-[170px]')}
				{@render statusSelect('w-[135px]')}
				{@render sourceSelect('w-[135px]')}
			</div>

			<Popover.Root bind:open={filtersOpen}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" class="shrink-0 gap-2">
							<SlidersHorizontalIcon class="size-4" />
							Filters
							{#if popoverOnlyCount > 0}
								<Badge
									variant="secondary"
									class="hidden h-5 min-w-5 rounded-full px-1.5 tabular-nums sm:inline-flex"
								>
									{popoverOnlyCount}
								</Badge>
							{/if}
							{#if popoverOnlyCount + inlineCount > 0}
								<Badge
									variant="secondary"
									class="h-5 min-w-5 rounded-full px-1.5 tabular-nums sm:hidden"
								>
									{popoverOnlyCount + inlineCount}
								</Badge>
							{/if}
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						align="end"
						sideOffset={6}
						collisionPadding={16}
						class="z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-2xl border border-border/40 bg-popover p-4 text-popover-foreground shadow-lg"
					>
						<!-- On phones the inline selects live here instead. -->
						<div class="flex flex-col gap-3 sm:hidden">
							<div class="flex flex-col gap-1.5">
								<span class="text-sm font-medium">Model</span>
								{@render modelSelect('w-full')}
							</div>
							<div class="flex flex-col gap-1.5">
								<span class="text-sm font-medium">Status</span>
								{@render statusSelect('w-full')}
							</div>
							<div class="flex flex-col gap-1.5">
								<span class="text-sm font-medium">Source</span>
								{@render sourceSelect('w-full')}
							</div>
						</div>

						{#if data.isAdmin}
							<div class="flex flex-col gap-1.5">
								<Label for="filter-user">User</Label>
								<Select.Root
									type="single"
									value={data.filters.user}
									onValueChange={(v) => setFilter('user', v)}
								>
									<Select.Trigger id="filter-user" class="w-full">
										{#if data.filters.user}
											{scopeUserName}
										{:else}
											<span class="text-muted-foreground">Everyone</span>
										{/if}
									</Select.Trigger>
									<Select.Content>
										<Select.Item value="">Everyone</Select.Item>
										{#each data.filterOptions.users as u (u.id)}
											<Select.Item value={u.id}>{u.name}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
						{/if}

						<div class="flex flex-col gap-1.5">
							<Label for="filter-provider">Provider</Label>
							<Select.Root
								type="single"
								value={data.filters.provider}
								onValueChange={(v) => setFilter('provider', v)}
							>
								<Select.Trigger id="filter-provider" class="w-full">
									{#if data.filters.provider}
										{data.filterOptions.providers.find((p) => p.id === data.filters.provider)
											?.name ?? data.filters.provider}
									{:else}
										<span class="text-muted-foreground">All providers</span>
									{/if}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="">All providers</Select.Item>
									{#each data.filterOptions.providers as p (p.id)}
										<Select.Item value={p.id}>{p.name}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>

						<div class="flex flex-col gap-1.5">
							<Label for="filter-key">API key</Label>
							<Select.Root
								type="single"
								value={data.filters.key}
								onValueChange={(v) => setFilter('key', v)}
							>
								<Select.Trigger id="filter-key" class="w-full">
									{#if data.filters.key}
										{data.filterOptions.keys.find((k) => k.id === data.filters.key)?.label ??
											data.filters.key}
									{:else}
										<span class="text-muted-foreground">All keys</span>
									{/if}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="">All keys</Select.Item>
									{#each data.filterOptions.keys as k (k.id)}
										<Select.Item value={k.id}>{k.label}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>

						<div class="flex flex-col gap-1.5">
							<Label for="filter-endpoint">Endpoint</Label>
							<Select.Root
								type="single"
								value={data.filters.endpoint}
								onValueChange={(v) => setFilter('endpoint', v)}
							>
								<Select.Trigger id="filter-endpoint" class="w-full">
									{#if data.filters.endpoint}
										<span class="font-mono text-xs">{data.filters.endpoint}</span>
									{:else}
										<span class="text-muted-foreground">All endpoints</span>
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
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		</div>

		{#if hasActiveFilters}
			<div class="flex flex-wrap items-center gap-2">
				<FilterIcon class="size-3.5 text-muted-foreground" />
				{#each activeFilters as chip (chip.key)}
					<Badge variant="secondary" class="max-w-full gap-1.5 rounded-lg pr-1.5 font-normal">
						<span class="text-muted-foreground">{chip.label}:</span>
						<span class="truncate">{chip.value}</span>
						<a
							href={chip.clearUrl}
							class="ml-0.5 rounded-md p-0.5 transition-colors hover:bg-muted"
							title="Remove {chip.label} filter"
							aria-label="Remove {chip.label} filter"
						>
							<XIcon class="size-3" />
						</a>
					</Badge>
				{/each}
				<!-- Clearing filters keeps the time range and whose requests are shown. -->
				<Button variant="ghost" size="sm" class="h-7 px-2" href={clearAllHref}>Clear all</Button>
			</div>
		{/if}
	</div>

	<!-- Summary: one row of KPIs and one chart, so the log stays near the top -->
	<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content class="flex flex-col gap-1">
				<span class="flex items-center justify-between gap-2 text-sm text-muted-foreground">
					Requests
					<ZapIcon class="size-4 shrink-0" aria-hidden="true" />
				</span>
				<span class="text-2xl font-semibold tabular-nums">{data.stats.total.toLocaleString()}</span>
			</Card.Content>
		</Card.Root>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content class="flex flex-col gap-1">
				<span class="flex items-center justify-between gap-2 text-sm text-muted-foreground">
					Success rate
					<CheckCircle2Icon class="size-4 shrink-0" aria-hidden="true" />
				</span>
				<span class="text-2xl font-semibold tabular-nums">{successRate}</span>
				{#if data.stats.failed > 0}
					<a
						href={filterUrl({ status: 'failed' })}
						class="text-xs text-destructive tabular-nums underline-offset-4 hover:underline"
					>
						{data.stats.failed.toLocaleString()} failed
					</a>
				{/if}
			</Card.Content>
		</Card.Root>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content class="flex flex-col gap-1">
				<span class="flex items-center justify-between gap-2 text-sm text-muted-foreground">
					Tokens
					<TrendingUpIcon class="size-4 shrink-0" aria-hidden="true" />
				</span>
				<span class="text-2xl font-semibold tabular-nums">
					{formatCount(data.stats.inputTokens + data.stats.outputTokens)}
				</span>
			</Card.Content>
		</Card.Root>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content class="flex flex-col gap-1">
				<span class="flex items-center justify-between gap-2 text-sm text-muted-foreground">
					Billed
					<DollarSignIcon class="size-4 shrink-0" aria-hidden="true" />
				</span>
				<span class="text-2xl font-semibold tabular-nums">
					{formatBilled(data.stats.costUsd, { pricedRequests: data.stats.pricedRequests })}
				</span>
				{#if data.stats.total > 0 && data.stats.pricedRequests === 0}
					<span class="text-sm font-medium text-muted-foreground">No cost reported</span>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	{#if data.stats.total > 0}
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Header class="pb-3">
				<Card.Title class="text-sm font-medium">Requests per day</Card.Title>
				<Card.Description>
					By model, {data.chartDaysCapped ? 'most recent 90 days' : data.rangeLabel}.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<DailyStackedChart
					rows={data.stackedRows}
					series={topSeries}
					valueFormat={(v) => formatCount(v)}
					emptyText="No requests in this period."
					class="max-h-[200px] min-h-[200px]"
				/>
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
			<!-- Phones: two-line rows, each one a link to the request. -->
			<ul class="flex flex-col divide-y divide-border/60 md:hidden">
				{#each data.requests as request (request.id)}
					<li>
						<a href={resolve(`/usage/requests/${request.id}`)} class="flex flex-col gap-1 py-3">
							<span class="flex items-center gap-2">
								<span
									class="min-w-0 flex-1 truncate text-sm font-medium"
									title={request.requestedModel}
								>
									{request.requestedModel}
								</span>
								<span
									class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium {statusTone(
										request.status
									)}"
								>
									<span class="size-1.5 rounded-full {statusDot(request.status)}"></span>
									{request.status}
								</span>
								<span
									class="shrink-0 text-xs text-muted-foreground"
									title={formatDateTime(request.startedAt, data.timeFormat)}
								>
									{formatTimeAgo(request.startedAt)}
								</span>
							</span>
							<span class="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
								<!-- Stats never truncate; the user name gives way first. -->
								<span class="shrink-0">
									{formatTokens(request.inputTokens, request.outputTokens)} tokens ·
									{formatLatency(request.latencyMs)} ·
									<span class="capitalize">{request.source}</span>
								</span>
								{#if data.isAdmin}
									<span class="min-w-0 truncate"
										>· {data.users[request.userId] ?? request.userId}</span
									>
								{/if}
								<!-- No cost reported: left to the detail page rather than a bare "—". -->
								{#if request.costUsd !== null}
									<span class="ml-auto shrink-0 text-sm text-foreground">
										{formatBilled(request.costUsd, { precise: true })}
									</span>
								{/if}
							</span>
						</a>
					</li>
				{:else}
					<li class="flex flex-col items-center gap-2 py-10 text-muted-foreground">
						<InboxIcon class="size-6" />
						<span class="text-sm">
							{hasActiveFilters ? 'No requests match your filters.' : 'No requests in this period.'}
						</span>
					</li>
				{/each}
			</ul>
			<div class="hidden md:block">
				<Table.Root>
					<Table.Header class="bg-muted/30">
						<Table.Row class="hover:bg-transparent">
							<Table.Head class="w-[150px] pl-4">Endpoint</Table.Head>
							<Table.Head>Model</Table.Head>
							<Table.Head class="w-[90px]">Source</Table.Head>
							<Table.Head>
								{data.isAdmin ? 'User / Key' : 'API key'}
							</Table.Head>
							<Table.Head class="w-[130px]">Status</Table.Head>
							<Table.Head class="w-[90px]">Started</Table.Head>
							<Table.Head class="w-[90px] text-right">Latency</Table.Head>
							<Table.Head class="w-[110px] text-right">Tokens</Table.Head>
							<Table.Head class="w-[90px] pr-4 text-right">Billed</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.requests as request (request.id)}
							<Table.Row
								class="group cursor-pointer transition-colors hover:bg-muted/40"
								onclick={() => goto(resolve(`/usage/requests/${request.id}`))}
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
											<span class="truncate text-xs text-muted-foreground">
												{providerName(request.providerId)}
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
										{#if data.isAdmin}
											<span class="truncate text-sm">
												{data.users[request.userId] ?? request.userId}
											</span>
										{/if}
										<!-- Key line only when a key was used; non-admins see just this column. -->
										{#if request.apiKeyId}
											<span class="truncate {data.isAdmin ? 'text-xs' : 'text-sm'}">
												{data.keys[request.apiKeyId] ?? request.apiKeyId}
											</span>
										{:else if !data.isAdmin}
											<span class="text-sm">—</span>
										{/if}
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
									<span
										class={request.costUsd ? 'font-medium' : 'text-muted-foreground'}
										title={request.costUsd === null ? NO_COST_REPORTED : undefined}
									>
										{formatBilled(request.costUsd, { precise: true })}
									</span>
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
												No requests in this period.
											{/if}
										</span>
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
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

	<!-- Deeper insights, below the log -->
	<section class="flex flex-col gap-3" aria-labelledby="insights-heading">
		<h2 id="insights-heading" class="text-base font-semibold">More insights</h2>
		<div class="grid gap-4 lg:grid-cols-2">
			<Card.Root class="rounded-2xl border-border/40">
				<Card.Header class="pb-3">
					<Card.Title class="text-sm font-medium">Top models</Card.Title>
					<Card.Description>Requests per model, {data.rangeLabel}.</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if data.topModels.length === 0}
						<p class="py-6 text-center text-sm text-muted-foreground">
							No requests in this period.
						</p>
					{:else}
						<ol class="flex flex-col gap-2.5">
							{#each data.topModels as m (m.model)}
								<li class="flex flex-col gap-1">
									<div class="flex items-baseline justify-between gap-3 text-sm">
										<a
											href={filterUrl({ model: m.model })}
											class="min-w-0 truncate font-mono text-xs underline-offset-4 hover:underline"
											title={m.model}
										>
											{m.model}
										</a>
										<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
											{m.count.toLocaleString()}{m.pricedRequests > 0
												? ` · ${formatBilled(m.costUsd, { pricedRequests: m.pricedRequests })}`
												: ''}
										</span>
									</div>
									<div class="h-1.5 overflow-hidden rounded-full bg-muted">
										<div
											class="h-full rounded-full"
											style:width="{Math.max(2, (m.count / maxTopCount) * 100)}%"
											style:background-color={seriesColors[m.model] ?? 'var(--chart-other)'}
										></div>
									</div>
								</li>
							{/each}
						</ol>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root class="rounded-2xl border-border/40">
				<Card.Header class="pb-3">
					<Card.Title class="text-sm font-medium">Activity history</Card.Title>
					<Card.Description>
						Daily requests over recent months — not limited by the time range above.
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-col gap-4">
					<ActivityHistogram data={data.dailyCounts} />
					<dl class="grid grid-cols-2 gap-3 text-sm">
						<div class="flex flex-col gap-0.5">
							<dt class="text-xs text-muted-foreground">Avg latency ({data.rangeLabel})</dt>
							<dd class="font-medium tabular-nums">
								{formatLatency(
									data.stats.avgLatencyMs !== null ? Math.round(data.stats.avgLatencyMs) : null
								)}
							</dd>
						</div>
						{#if data.stats.cavemanSaved > 0}
							<div class="flex flex-col gap-0.5">
								<dt class="text-xs text-muted-foreground">Tokens saved by prompt compression</dt>
								<dd class="font-medium tabular-nums">{formatCount(data.stats.cavemanSaved)}</dd>
							</div>
						{/if}
					</dl>
				</Card.Content>
			</Card.Root>
		</div>
	</section>
</div>
