<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import DailyStackedChart from '$lib/components/app/usage/DailyStackedChart.svelte';
	import SegmentedToggle from '$lib/components/app/SegmentedToggle.svelte';
	import { modelColors, USAGE_PERIODS, type UsagePeriod } from '$lib/components/app/usage/usage.js';
	import { formatTimeAgo } from '$lib/datetime.js';
	import { formatLatency, formatWholeCountTick } from '$lib/formats.js';
	import type { McpServerInfo, McpServerUsage, McpUsageStats } from '$lib/types.js';

	let {
		stats,
		period,
		servers,
		usage,
		onPeriodChange,
		onShowServer
	}: {
		stats: McpUsageStats;
		period: UsagePeriod;
		servers: McpServerInfo[];
		/** All-time last use per server id, for servers idle in this period. */
		usage: Record<string, McpServerUsage>;
		onPeriodChange: (period: UsagePeriod) => void;
		/** Opens a server's per-tool breakdown. */
		onShowServer: (server: McpServerInfo) => void;
	} = $props();

	type Metric = 'calls' | 'errors';
	let metric = $state<Metric>('calls');

	const byId = $derived(new Map(servers.map((s) => [s.id, s])));
	const nameOf = (id: string) => byId.get(id)?.name ?? 'Deleted server';
	// Colors follow the server name, so a server keeps its color across periods.
	const colors = $derived(
		modelColors(
			stats.servers.map((s) => nameOf(s.serverId)),
			servers.map((s) => s.name)
		)
	);
	const colorOf = (id: string) => colors[nameOf(id)];

	const series = $derived(
		stats.servers.map((s) => ({
			key: s.serverId,
			label: nameOf(s.serverId),
			color: colorOf(s.serverId)
		}))
	);
	const chartRows = $derived(
		stats.daily.map((d) => {
			const row: Record<string, string | number> = { day: d.day };
			for (const s of series) row[s.key] = d[metric][s.key] ?? 0;
			return row;
		})
	);

	const totals = $derived(
		stats.servers.reduce(
			(sum, s) => ({ calls: sum.calls + s.calls, errors: sum.errors + s.errors }),
			{ calls: 0, errors: 0 }
		)
	);
	const enabledServers = $derived(servers.filter((s) => s.enabled));
	const usedIds = $derived(new Set(stats.servers.map((s) => s.serverId)));
	// Enabled but never called in this period: the candidates for removal.
	const idle = $derived(enabledServers.filter((s) => !usedIds.has(s.id)));
	const usedEnabled = $derived(enabledServers.filter((s) => usedIds.has(s.id)).length);

	/** Share as a whole percent; any nonzero part shows as at least 1%. */
	const percent = (part: number, whole: number) =>
		whole === 0 || part === 0 ? '0%' : `${Math.max(1, Math.round((part / whole) * 100))}%`;

	const tiles = $derived([
		{ label: 'Calls', value: totals.calls.toLocaleString() },
		{ label: 'Failed', value: percent(totals.errors, totals.calls) },
		{ label: 'Users', value: stats.users.toLocaleString() },
		{ label: 'Servers used', value: `${usedEnabled} of ${enabledServers.length}` }
	]);
</script>

<div class="flex flex-col gap-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<p class="text-sm text-muted-foreground">
			Tool calls by all users over the last {stats.days} days.
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

	<section class="flex flex-col gap-3" aria-labelledby="mcp-daily-heading">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 id="mcp-daily-heading" class="text-base font-semibold">
				{metric === 'calls' ? 'Calls per day' : 'Failed calls per day'}
			</h2>
			<SegmentedToggle
				label="Metric"
				options={[
					{ value: 'calls', label: 'Calls' },
					{ value: 'errors', label: 'Failed' }
				]}
				value={metric}
				onChange={(m) => (metric = m)}
			/>
		</div>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content>
				<DailyStackedChart
					rows={chartRows}
					{series}
					valueFormat={(v) => v.toLocaleString()}
					axisFormat={formatWholeCountTick}
					emptyText={metric === 'calls'
						? 'No MCP tool was called in this period.'
						: 'No failed calls in this period.'}
				/>
			</Card.Content>
		</Card.Root>
	</section>

	<section class="flex flex-col gap-3" aria-labelledby="mcp-servers-heading">
		<div class="flex flex-col gap-1">
			<h2 id="mcp-servers-heading" class="text-base font-semibold">By server</h2>
			<p class="text-sm text-muted-foreground">
				Enabled servers nobody used in this period are listed last. Select one to see its tools.
			</p>
		</div>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content>
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Server</Table.Head>
							<Table.Head class="text-right">Calls</Table.Head>
							<Table.Head class="hidden text-right sm:table-cell">Share</Table.Head>
							<Table.Head class="text-right">Failed</Table.Head>
							<Table.Head class="hidden text-right md:table-cell">Avg time</Table.Head>
							<Table.Head class="hidden text-right md:table-cell">Users</Table.Head>
							<Table.Head class="text-right">Last used</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each stats.servers as s (s.serverId)}
							{@const server = byId.get(s.serverId)}
							<Table.Row>
								<Table.Cell class="max-w-48">
									<span class="flex min-w-0 items-center gap-2">
										<span
											class="size-2 shrink-0 rounded-full"
											style:background-color={colorOf(s.serverId)}
										></span>
										{#if server}
											<button
												type="button"
												class="truncate rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
												title={server.name}
												onclick={() => onShowServer(server)}>{server.name}</button
											>
											{#if !server.enabled}
												<Badge variant="outline" class="text-muted-foreground">Off</Badge>
											{/if}
										{:else}
											<span class="truncate text-muted-foreground">Deleted server</span>
										{/if}
									</span>
								</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{s.calls.toLocaleString()}</Table.Cell>
								<Table.Cell
									class="hidden text-right text-muted-foreground tabular-nums sm:table-cell"
								>
									{percent(s.calls, totals.calls)}
								</Table.Cell>
								<Table.Cell
									class="text-right tabular-nums {s.errors
										? 'text-destructive'
										: 'text-muted-foreground'}"
								>
									{s.errors ? percent(s.errors, s.calls) : '—'}
								</Table.Cell>
								<Table.Cell
									class="hidden text-right text-muted-foreground tabular-nums md:table-cell"
								>
									{formatLatency(s.avgMs)}
								</Table.Cell>
								<Table.Cell
									class="hidden text-right text-muted-foreground tabular-nums md:table-cell"
								>
									{s.users}
								</Table.Cell>
								<Table.Cell class="text-right whitespace-nowrap text-muted-foreground">
									{formatTimeAgo(s.lastUsedAt)}
								</Table.Cell>
							</Table.Row>
						{/each}
						{#each idle as server (server.id)}
							{@const last = usage[server.id]?.lastUsedAt}
							<Table.Row class="text-muted-foreground">
								<Table.Cell class="max-w-48">
									<span class="flex min-w-0 items-center gap-2">
										<span class="size-2 shrink-0 rounded-full bg-border"></span>
										<button
											type="button"
											class="truncate rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
											title={server.name}
											onclick={() => onShowServer(server)}>{server.name}</button
										>
										<Badge variant="outline" class="text-muted-foreground">Unused</Badge>
									</span>
								</Table.Cell>
								<Table.Cell class="text-right tabular-nums">0</Table.Cell>
								<Table.Cell class="hidden text-right sm:table-cell">—</Table.Cell>
								<Table.Cell class="text-right">—</Table.Cell>
								<Table.Cell class="hidden text-right md:table-cell">—</Table.Cell>
								<Table.Cell class="hidden text-right md:table-cell">—</Table.Cell>
								<Table.Cell class="text-right whitespace-nowrap">
									{last ? formatTimeAgo(last) : 'Never'}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	</section>
</div>
