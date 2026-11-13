<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import DailyStackedChart from '$lib/components/app/usage/DailyStackedChart.svelte';
	import SegmentedToggle from '$lib/components/app/SegmentedToggle.svelte';
	import {
		modelColors,
		periodQuery,
		USAGE_PERIODS,
		type UsagePeriod
	} from '$lib/components/app/usage/usage.js';
	import { formatTimeAgo } from '$lib/datetime.js';
	import {
		formatCount,
		formatLatency,
		formatSpend,
		formatSpendCompact,
		formatWholeCountTick
	} from '$lib/formats.js';
	import type { ApiKey, ApiKeyUsageStats } from '$lib/types.js';

	let {
		stats,
		period,
		keys,
		onPeriodChange
	}: {
		stats: ApiKeyUsageStats;
		period: UsagePeriod;
		/** The user's current keys (stats may also name deleted ones). */
		keys: ApiKey[];
		onPeriodChange: (period: UsagePeriod) => void;
	} = $props();

	type Metric = 'requests' | 'tokens' | 'cost';
	let metric = $state<Metric>('requests');

	const byId = $derived(new Map(keys.map((k) => [k.id, k])));
	const labelOf = (id: string) => byId.get(id)?.label ?? 'Deleted key';
	// Colors follow the key (by id, since labels needn't be unique), so a key keeps its
	// color across periods and metrics.
	const colors = $derived(
		modelColors(
			stats.keys.map((k) => k.keyId),
			keys.map((k) => k.id)
		)
	);

	const series = $derived(
		stats.keys.map((k) => ({ key: k.keyId, label: labelOf(k.keyId), color: colors[k.keyId] }))
	);
	const chartRows = $derived(
		stats.daily.map((d) => {
			const row: Record<string, string | number> = { day: d.day };
			for (const s of series) {
				const v = d[metric][s.key] ?? 0;
				row[s.key] = metric === 'cost' ? Math.round(v * 100) / 100 : v;
			}
			return row;
		})
	);

	const totals = $derived(
		stats.keys.reduce(
			(sum, k) => ({
				requests: sum.requests + k.requests,
				runs: sum.runs + k.runs,
				tokens: sum.tokens + k.tokens,
				costUsd: sum.costUsd + k.costUsd,
				priced: sum.priced + k.pricedRequests
			}),
			{ requests: 0, runs: 0, tokens: 0, costUsd: 0, priced: 0 }
		)
	);
	const usedIds = $derived(new Set(stats.keys.map((k) => k.keyId)));
	// Keys nobody used in this period: candidates for deletion.
	const idle = $derived(keys.filter((k) => !usedIds.has(k.id)));

	/** Spend, marked as a lower bound ("+") when some requests reported no cost. */
	function cost(usd: number, priced: number, requests: number): string {
		if (priced === 0) return '—';
		return `${formatSpend(usd)}${priced < requests ? '+' : ''}`;
	}
	/** Share as a whole percent; any nonzero part shows as at least 1%. */
	const percent = (part: number, whole: number) =>
		whole === 0 || part === 0 ? '0%' : `${Math.max(1, Math.round((part / whole) * 100))}%`;

	const tiles = $derived([
		{ label: 'Requests', value: totals.requests.toLocaleString() },
		{ label: 'Agent runs', value: totals.runs.toLocaleString() },
		{ label: 'Tokens', value: formatCount(totals.tokens) },
		{ label: 'Cost', value: cost(totals.costUsd, totals.priced, totals.requests) }
	]);

	const METRICS = [
		{ value: 'requests', label: 'Requests' },
		{ value: 'tokens', label: 'Tokens' },
		{ value: 'cost', label: 'Cost' }
	] as const;
	const heading = { requests: 'Requests per day', tokens: 'Tokens per day', cost: 'Cost per day' };

	/** The key's own requests in Usage → Requests, over the same period. */
	function requestsHref(keyId: string): string {
		return `${resolve('/usage/requests')}${periodQuery(period, { key: keyId })}`;
	}
</script>

<div class="flex flex-col gap-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<p class="text-sm text-muted-foreground">
			Requests made with your API keys over the last {stats.days} days, including those of agent runs
			a key started.
		</p>
		<SegmentedToggle
			label="Period"
			options={USAGE_PERIODS.map((p) => ({ value: p, label: p }))}
			value={period}
			onChange={onPeriodChange}
		/>
	</div>

	<dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		{#each tiles as tile (tile.label)}
			<Card.Root class="rounded-2xl border-border/40 py-4">
				<Card.Content class="flex flex-col gap-1 px-4">
					<dt class="text-sm text-muted-foreground">{tile.label}</dt>
					<dd class="text-2xl font-semibold tabular-nums">{tile.value}</dd>
				</Card.Content>
			</Card.Root>
		{/each}
	</dl>

	<section class="flex flex-col gap-3" aria-labelledby="api-daily-heading">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 id="api-daily-heading" class="text-base font-semibold">{heading[metric]}</h2>
			<SegmentedToggle
				label="Metric"
				options={METRICS}
				value={metric}
				onChange={(m) => (metric = m)}
			/>
		</div>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content>
				<DailyStackedChart
					rows={chartRows}
					{series}
					valueFormat={metric === 'cost' ? formatSpend : (v) => v.toLocaleString()}
					axisFormat={metric === 'cost'
						? formatSpendCompact
						: metric === 'tokens'
							? formatCount
							: formatWholeCountTick}
					emptyText={metric === 'cost'
						? 'No priced requests in this period.'
						: 'No requests with an API key in this period.'}
				/>
			</Card.Content>
		</Card.Root>
	</section>

	<section class="flex flex-col gap-3" aria-labelledby="api-keys-usage-heading">
		<div class="flex flex-col gap-1">
			<h2 id="api-keys-usage-heading" class="text-base font-semibold">By key</h2>
			<p class="text-sm text-muted-foreground">
				Keys nobody used in this period are listed last. Select one to see its requests.
			</p>
		</div>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content>
				{#if stats.keys.length === 0 && idle.length === 0}
					<p class="py-3 text-sm text-muted-foreground">You have no API keys yet.</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Key</Table.Head>
								<Table.Head class="text-right">Requests</Table.Head>
								<Table.Head class="hidden text-right sm:table-cell">Runs</Table.Head>
								<Table.Head class="hidden text-right md:table-cell">Tokens</Table.Head>
								<Table.Head class="text-right">Cost</Table.Head>
								<Table.Head class="hidden text-right sm:table-cell">Failed</Table.Head>
								<Table.Head class="hidden text-right lg:table-cell">Avg time</Table.Head>
								<Table.Head class="text-right">Last used</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each stats.keys as k (k.keyId)}
								{@const key = byId.get(k.keyId)}
								<Table.Row>
									<Table.Cell class="max-w-48">
										<span class="flex min-w-0 items-center gap-2">
											<span
												class="size-2 shrink-0 rounded-full"
												style:background-color={colors[k.keyId]}
											></span>
											{#if key}
												<!-- Built from resolve('/usage/requests'). -->
												<!-- eslint-disable svelte/no-navigation-without-resolve -->
												<a
													href={requestsHref(k.keyId)}
													class="truncate rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
													title={key.label}>{key.label}</a
												>
												<!-- eslint-enable svelte/no-navigation-without-resolve -->
											{:else}
												<span class="truncate text-muted-foreground">Deleted key</span>
											{/if}
										</span>
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">
										{k.requests.toLocaleString()}
									</Table.Cell>
									<Table.Cell
										class="hidden text-right text-muted-foreground tabular-nums sm:table-cell"
									>
										{k.runs ? k.runs.toLocaleString() : '—'}
									</Table.Cell>
									<Table.Cell
										class="hidden text-right text-muted-foreground tabular-nums md:table-cell"
										title={k.tokens.toLocaleString()}
									>
										{formatCount(k.tokens)}
									</Table.Cell>
									<Table.Cell class="text-right whitespace-nowrap tabular-nums">
										{cost(k.costUsd, k.pricedRequests, k.requests)}
									</Table.Cell>
									<Table.Cell
										class="hidden text-right tabular-nums sm:table-cell {k.failed
											? 'text-destructive'
											: 'text-muted-foreground'}"
									>
										{k.failed ? percent(k.failed, k.requests) : '—'}
									</Table.Cell>
									<Table.Cell
										class="hidden text-right text-muted-foreground tabular-nums lg:table-cell"
									>
										{formatLatency(k.avgLatencyMs)}
									</Table.Cell>
									<Table.Cell class="text-right whitespace-nowrap text-muted-foreground">
										{formatTimeAgo(k.lastUsedAt)}
									</Table.Cell>
								</Table.Row>
							{/each}
							{#each idle as key (key.id)}
								<Table.Row class="text-muted-foreground">
									<Table.Cell class="max-w-48">
										<span class="flex min-w-0 items-center gap-2">
											<span class="size-2 shrink-0 rounded-full bg-border"></span>
											<span class="truncate" title={key.label}>{key.label}</span>
											<Badge variant="outline" class="text-muted-foreground">Unused</Badge>
										</span>
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">0</Table.Cell>
									<Table.Cell class="hidden text-right sm:table-cell">—</Table.Cell>
									<Table.Cell class="hidden text-right md:table-cell">—</Table.Cell>
									<Table.Cell class="text-right">—</Table.Cell>
									<Table.Cell class="hidden text-right sm:table-cell">—</Table.Cell>
									<Table.Cell class="hidden text-right lg:table-cell">—</Table.Cell>
									<Table.Cell class="text-right whitespace-nowrap">
										{key.lastUsedAt ? formatTimeAgo(key.lastUsedAt) : 'Never'}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Card.Content>
		</Card.Root>
	</section>
</div>
