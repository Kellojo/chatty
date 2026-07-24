<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { formatDateTime, formatTimeAgo } from '$lib/datetime.js';
	import { formatCount } from '$lib/format.js';
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

	const selectClass = 'rounded-md border bg-background px-3 py-1.5 text-sm';

	function statusVariant(status: ProxyRequestStatus): 'outline' | 'secondary' | 'destructive' {
		if (status === 'running') return 'outline';
		if (status === 'complete') return 'secondary';
		return 'destructive';
	}

	function statusClass(status: ProxyRequestStatus): string {
		if (status === 'running') return 'border-info/50 text-info-foreground';
		if (status === 'complete') return 'text-success-foreground';
		return '';
	}

	function formatCost(usd: number): string {
		return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(5)}`;
	}

	function formatTokens(input: number | null, output: number | null): string {
		if (input === null && output === null) return '—';
		return `${input === null ? '—' : formatCount(input)} / ${output === null ? '—' : formatCount(output)}`;
	}

	function pageHref(pageNum: number): string {
		const parts: string[] = [];
		for (const [key, value] of Object.entries(data.filters)) {
			if (value) parts.push(`${key}=${encodeURIComponent(value)}`);
		}
		if (pageNum > 1) parts.push(`page=${pageNum}`);
		const qs = parts.join('&');
		return qs ? `${resolve('/requests')}?${qs}` : resolve('/requests');
	}

	const successRate = $derived(
		data.stats.total > 0 ? `${Math.round((data.stats.completed / data.stats.total) * 100)}%` : '—'
	);

	const hasActiveFilters = $derived(
		Boolean(data.filters.user || data.filters.key || data.filters.model)
	);
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
		<div class="flex flex-col gap-1">
			<h1 class="flex items-center gap-2 text-xl font-semibold">
				<ScrollTextIcon class="size-5" />
				Requests
			</h1>
		</div>

		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
			<Card.Root size="sm">
				<Card.Header>
					<Card.Description>Total requests</Card.Description>
					<Card.Title class="text-2xl">{data.stats.total.toLocaleString()}</Card.Title>
				</Card.Header>
			</Card.Root>
			<Card.Root size="sm">
				<Card.Header>
					<Card.Description>Success rate</Card.Description>
					<Card.Title class="text-2xl">{successRate}</Card.Title>
				</Card.Header>
			</Card.Root>
			<Card.Root size="sm">
				<Card.Header>
					<Card.Description>Avg latency</Card.Description>
					<Card.Title class="text-2xl">
						{data.stats.avgLatencyMs !== null ? `${Math.round(data.stats.avgLatencyMs)} ms` : '—'}
					</Card.Title>
				</Card.Header>
			</Card.Root>
			<Card.Root size="sm">
				<Card.Header>
					<Card.Description>Tokens in / out</Card.Description>
					<Card.Title class="text-2xl">
						{formatCount(data.stats.inputTokens)} / {formatCount(data.stats.outputTokens)}
					</Card.Title>
				</Card.Header>
			</Card.Root>
			<Card.Root size="sm">
				<Card.Header>
					<Card.Description>Total cost</Card.Description>
					<Card.Title class="text-2xl">{formatCost(data.stats.costUsd)}</Card.Title>
				</Card.Header>
			</Card.Root>
			<Card.Root size="sm">
				<Card.Header>
					<Card.Description>Distinct models</Card.Description>
					<Card.Title class="text-2xl">{data.stats.distinctModels}</Card.Title>
				</Card.Header>
			</Card.Root>
			<Card.Root size="sm">
				<Card.Header>
					<Card.Description>Caveman saved (est.)</Card.Description>
					<Card.Title class="text-2xl">{formatCount(data.stats.cavemanSaved)}</Card.Title>
				</Card.Header>
			</Card.Root>
		</div>

		<form method="GET" class="flex flex-wrap items-end gap-2">
			<div class="flex flex-col gap-1">
				<Label for="filter-user">User</Label>
				<select
					id="filter-user"
					name="user"
					class={selectClass}
					onchange={(e) => e.currentTarget.form?.requestSubmit()}
				>
					<option value="" selected={data.filters.user === ''}>All users</option>
					{#each data.filterOptions.users as user (user.id)}
						<option value={user.id} selected={data.filters.user === user.id}>{user.name}</option>
					{/each}
				</select>
			</div>
			<div class="flex flex-col gap-1">
				<Label for="filter-key">API key</Label>
				<select
					id="filter-key"
					name="key"
					class={selectClass}
					onchange={(e) => e.currentTarget.form?.requestSubmit()}
				>
					<option value="" selected={data.filters.key === ''}>All keys</option>
					{#each data.filterOptions.keys as key (key.id)}
						<option value={key.id} selected={data.filters.key === key.id}>{key.label}</option>
					{/each}
				</select>
			</div>
			<div class="flex flex-col gap-1">
				<Label for="filter-model">Model</Label>
				<select
					id="filter-model"
					name="model"
					class={selectClass}
					onchange={(e) => e.currentTarget.form?.requestSubmit()}
				>
					<option value="" selected={data.filters.model === ''}>All models</option>
					{#each data.filterOptions.models as model (model)}
						<option value={model} selected={data.filters.model === model}>{model}</option>
					{/each}
				</select>
			</div>
			{#if hasActiveFilters}
				<Button variant="outline" size="sm" href={resolve('/requests')}>Reset</Button>
			{/if}
		</form>

		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Status</Table.Head>
					<Table.Head>Endpoint</Table.Head>
					<Table.Head>Model</Table.Head>
					<Table.Head>User / Key</Table.Head>
					<Table.Head>Started</Table.Head>
					<Table.Head class="text-right">Latency</Table.Head>
					<Table.Head class="text-right">Tokens in / out</Table.Head>
					<Table.Head class="text-right">Cost</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.requests as request (request.id)}
					<Table.Row
						class="cursor-pointer"
						onclick={() => goto(resolve(`/requests/${request.id}`))}
					>
						<Table.Cell>
							<Badge variant={statusVariant(request.status)} class={statusClass(request.status)}>
								{#if request.status === 'running'}
									<span class="size-2 animate-pulse rounded-full bg-info"></span>
								{/if}
								{request.status}
							</Badge>
						</Table.Cell>
						<Table.Cell>
							<Badge variant="secondary">{request.endpoint}</Badge>
						</Table.Cell>
						<Table.Cell class="max-w-0 w-full">
							<div class="flex flex-col gap-0.5">
								<span class="truncate font-medium" title={request.requestedModel}>
									{request.requestedModel}
								</span>
								<span
									class="truncate text-xs text-muted-foreground"
									title={request.modelId ?? undefined}
								>
									{#if request.modelId}
										{request.modelId}
										{#if request.fallbackIndex > 0}
											<Badge variant="outline" class="ml-1">+{request.fallbackIndex}</Badge>
										{/if}
									{:else}
										—
									{/if}
								</span>
							</div>
						</Table.Cell>
						<Table.Cell class="text-muted-foreground">
							<div class="flex flex-col gap-0.5">
								<span class="truncate">{data.users[request.userId] ?? request.userId}</span>
								<span class="truncate text-xs">
									{request.apiKeyId ? (data.keys[request.apiKeyId] ?? request.apiKeyId) : '—'}
								</span>
							</div>
						</Table.Cell>
						<Table.Cell class="whitespace-nowrap text-muted-foreground">
							<span title={formatDateTime(request.startedAt, data.timeFormat)}>
								{formatTimeAgo(request.startedAt)}
							</span>
						</Table.Cell>
						<Table.Cell class="whitespace-nowrap text-right text-muted-foreground">
							{request.latencyMs !== null ? `${request.latencyMs} ms` : '—'}
						</Table.Cell>
						<Table.Cell class="whitespace-nowrap text-right text-muted-foreground">
							{formatTokens(request.inputTokens, request.outputTokens)}
						</Table.Cell>
						<Table.Cell class="whitespace-nowrap text-right text-muted-foreground">
							{request.costUsd !== null ? formatCost(request.costUsd) : '—'}
						</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={8} class="text-center text-muted-foreground">
							No requests yet.
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>

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
					Previous
				</Button>
				<Button
					variant="outline"
					size="sm"
					href={pageHref(data.page + 1)}
					disabled={data.page >= data.totalPages}
				>
					Next
				</Button>
			</div>
		</div>
	</div>
</div>
