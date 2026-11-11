<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import DailyStackedChart from '$lib/components/app/usage/DailyStackedChart.svelte';
	import EnvironmentCard from '$lib/components/app/usage/EnvironmentCard.svelte';
	import QuotaCard from '$lib/components/app/usage/QuotaCard.svelte';
	import PlanLimitBar from '$lib/components/app/usage/PlanLimitBar.svelte';
	import { limitHistoryKey } from '$lib/components/app/usage/burndown.js';
	import {
		formatApiValue,
		subscriptionColor,
		usageAccountsByProvider
	} from '$lib/components/app/usage/usage.js';
	import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';
	import { providerLabel } from '$lib/coding-environments.js';
	import { formatCount, formatSpend, formatSpendCompact } from '$lib/formats.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(id);
	});

	type Metric = 'cost' | 'tokens';
	let metric = $state<Metric>('cost');

	const subs = $derived(data.subscriptions);
	const rangeLabel = $derived(data.rangeLabel);
	const limitRange = $derived({
		from: data.limitRange.from ?? undefined,
		to: data.limitRange.to ?? undefined
	});
	// Some limit window has no synced history yet (a fresh install or a new account).
	// One quota card per provider; a login seen through several environments counts once.
	const providerQuotas = $derived(usageAccountsByProvider(subs.accounts));
	const historyPending = $derived(
		subs.accounts.some((a) => a.windows.some((w) => !data.limitHistory[limitHistoryKey(w)]?.length))
	);

	const series = $derived(
		subs.providers.map((p) => ({
			key: p.provider,
			label: providerLabel(p.provider),
			color: subscriptionColor(p.provider)
		}))
	);
	const chartRows = $derived(
		subs.dailyRows.map((row) => {
			const out: Record<string, string | number> = { day: row.day };
			for (const s of series) {
				const value = row[metric][s.key] ?? 0;
				out[s.key] = metric === 'cost' ? Math.round(value * 100) / 100 : value;
			}
			return out;
		})
	);
	const sampleWindow = $derived<CodingUsageLimitWindow>({
		environmentId: '',
		accountId: '',
		provider: 'claude',
		accountLabel: 'Claude',
		accountEmail: null,
		accountPlan: null,
		windowId: 'sample',
		windowKind: 'weekly',
		windowLabel: 'Weekly',
		usedPercent: 61,
		resetsAt: now + 3 * 86_400_000,
		checkedAt: now
	});
</script>

<svelte:head><title>Subscriptions · Usage · Chatty</title></svelte:head>

<div class="flex flex-col gap-6">
	{#if subs.environments.length === 0}
		<!-- Empty state: show what this tab will hold, with the one connect CTA. -->
		<Card.Root class="rounded-2xl border-dashed border-border/60">
			<Card.Content class="grid gap-6 md:grid-cols-2 md:items-center">
				<div class="flex flex-col items-start gap-3">
					<h2 class="text-base font-semibold">Track your subscriptions</h2>
					<p class="text-sm text-muted-foreground">
						Connect a T3 Code coding environment to see your Claude, Codex and other fixed-price
						plans here: how close each plan is to its limit, when it resets, and the API-equivalent
						value of what you used. None of it is billed by Chatty.
					</p>
					<Button href={resolve('/settings/environments')}>Connect environment</Button>
				</div>
				<div
					class="pointer-events-none flex flex-col gap-3 rounded-xl border border-border/40 p-4 opacity-60 select-none"
					aria-hidden="true"
				>
					<span class="text-xs text-muted-foreground">Example</span>
					<PlanLimitBar window={sampleWindow} label="Claude · Weekly" ariaLabel="Example" {now} />
					<span class="text-xs text-muted-foreground tabular-nums"
						>≈ $48.20 API value · 1.2M tokens</span
					>
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<p class="text-sm text-muted-foreground">
			Your fixed-price plans (Claude, Codex, …), synced from your coding environments. Dollar values
			are API list prices for comparison; you are not billed per token.
		</p>

		<!-- Plan limits -->
		{#if subs.accounts.length > 0}
			<section class="flex flex-col gap-3" aria-labelledby="limits-heading">
				<div class="flex flex-col gap-1">
					<h2 id="limits-heading" class="text-base font-semibold">Plan limits</h2>
					<p class="text-sm text-muted-foreground">
						Your weekly limits, {rangeLabel}, projected through the next resets at your current
						pace.
						{#if historyPending}
							History fills in with each sync.
						{/if}
					</p>
				</div>
				{#each providerQuotas as q (q.provider)}
					<QuotaCard
						provider={q.provider}
						accounts={q.accounts}
						history={data.limitHistory}
						range={limitRange}
						{now}
					/>
				{/each}
			</section>
		{/if}

		<!-- Coding environments -->
		<section class="flex flex-col gap-3" aria-labelledby="envs-heading">
			<div class="flex items-center justify-between gap-2">
				<h2 id="envs-heading" class="text-base font-semibold">Coding environments</h2>
				<Button variant="ghost" size="sm" href={resolve('/settings/environments')}>
					<span class="sm:hidden">Manage</span><span class="hidden sm:inline"
						>Manage environments</span
					>
					<ArrowRightIcon />
				</Button>
			</div>
			<div class="grid gap-3 {subs.environments.length > 1 ? 'sm:grid-cols-2 lg:grid-cols-3' : ''}">
				{#each subs.environments as env (env.id)}
					<EnvironmentCard environment={env} {now} compact={subs.environments.length === 1} />
				{/each}
			</div>
		</section>

		<!-- Usage by provider -->
		{#if subs.providers.length > 0}
			<section class="flex flex-col gap-3" aria-labelledby="providers-heading">
				<div class="flex flex-col gap-1">
					<h2 id="providers-heading" class="text-base font-semibold">Usage by provider</h2>
					<p class="text-sm text-muted-foreground">Tokens and API value, {rangeLabel}.</p>
				</div>
				{#if subs.note}
					<p class="text-sm text-muted-foreground">{subs.note}</p>
				{/if}

				<div class="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
					{#each subs.providers as p (p.provider)}
						<!-- Anchor target for the Overview's "By provider" links. -->
						<Card.Root
							id="provider-{p.provider}"
							class="scroll-mt-4 rounded-2xl border-border/40 py-4 target:ring-2 target:ring-ring"
						>
							<Card.Content class="flex flex-col gap-1">
								<span class="flex items-center gap-2 text-sm text-muted-foreground">
									<span
										class="size-2.5 shrink-0 rounded-full"
										style:background-color={subscriptionColor(p.provider)}
									></span>
									{providerLabel(p.provider)}
								</span>
								<!-- Same units on every card: tokens first, value second. -->
								<span class="text-xl font-semibold tabular-nums">
									{formatCount(p.tokens)} tokens
								</span>
								<span class="text-sm text-muted-foreground tabular-nums">
									{#if p.costUsd === 0 && !p.priced}
										Not priced — no API list price known
									{:else}
										{formatApiValue(p.costUsd, !p.priced)} API value
									{/if}
									· {formatCount(p.sessions)}
									{p.sessions === 1 ? 'session' : 'sessions'}
								</span>
							</Card.Content>
						</Card.Root>
					{/each}
				</div>
			</section>

			<!-- Daily value -->
			<section class="flex flex-col gap-3" aria-labelledby="daily-heading">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<h2 id="daily-heading" class="text-base font-semibold">
						{metric === 'cost' ? 'Daily value' : 'Daily tokens'}
					</h2>
					<div class="flex rounded-lg border p-0.5" role="group" aria-label="Metric">
						{#each [['cost', 'Value'], ['tokens', 'Tokens']] as [value, label] (value)}
							<button
								type="button"
								class="rounded-md px-2.5 py-1 text-xs {metric === value
									? 'bg-accent font-medium text-accent-foreground'
									: 'text-muted-foreground hover:text-foreground'}"
								aria-pressed={metric === value}
								onclick={() => (metric = value as Metric)}
							>
								{label}
							</button>
						{/each}
					</div>
				</div>
				<Card.Root class="rounded-2xl border-border/40">
					<Card.Content class="flex flex-col gap-4">
						<p class="text-sm text-muted-foreground">
							{#if metric === 'cost'}
								<span class="font-medium text-foreground tabular-nums"
									>{formatApiValue(subs.totalValueUsd, subs.anyUnpriced)}</span
								>
								API value, {rangeLabel} — covered by your subscriptions, not billed per token.
							{:else}
								Input, cached and output tokens combined.
							{/if}
						</p>
						<DailyStackedChart
							rows={chartRows}
							{series}
							valueFormat={metric === 'cost' ? formatSpend : formatCount}
							axisFormat={metric === 'cost' ? formatSpendCompact : formatCount}
							emptyText="No usage recorded in this period."
						/>
					</Card.Content>
				</Card.Root>
			</section>

			<!-- By model -->
			<section class="flex flex-col gap-3" aria-labelledby="models-heading">
				<div class="flex flex-col gap-1">
					<h2 id="models-heading" class="text-base font-semibold">By model</h2>
					<p class="text-sm text-muted-foreground">
						{rangeLabel[0].toUpperCase() + rangeLabel.slice(1)}.
					</p>
				</div>
				<Card.Root class="rounded-2xl border-border/40">
					<Card.Content>
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="hidden sm:table-cell">Provider</Table.Head>
									<Table.Head>Model</Table.Head>
									<Table.Head class="text-right">Tokens</Table.Head>
									<Table.Head class="hidden text-right sm:table-cell">Sessions</Table.Head>
									<Table.Head class="text-right">API value</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each subs.providers as p (p.provider)}
									{#each p.models as m (m.model)}
										<Table.Row>
											<Table.Cell class="hidden sm:table-cell">
												<span class="flex items-center gap-2 whitespace-nowrap">
													<span
														class="size-2 shrink-0 rounded-full"
														style:background-color={subscriptionColor(p.provider)}
													></span>
													{providerLabel(p.provider)}
												</span>
											</Table.Cell>
											<Table.Cell class="max-w-64 truncate font-mono text-[13px]" title={m.model}>
												<!-- The provider column is hidden on narrow screens; its dot moves here. -->
												<span
													class="mr-1.5 inline-block size-2 rounded-full sm:hidden"
													style:background-color={subscriptionColor(p.provider)}
													aria-hidden="true"
												></span><span class="sr-only sm:hidden"
													>{providerLabel(p.provider)}:
												</span>{m.model}
											</Table.Cell>
											<Table.Cell class="text-right tabular-nums" title={m.tokens.toLocaleString()}>
												{formatCount(m.tokens)}
											</Table.Cell>
											<Table.Cell class="hidden text-right tabular-nums sm:table-cell"
												>{formatCount(m.sessions)}</Table.Cell
											>
											<Table.Cell
												class="text-right whitespace-nowrap text-muted-foreground tabular-nums"
											>
												{formatApiValue(m.costUsd, !m.priced)}
											</Table.Cell>
										</Table.Row>
									{/each}
								{/each}
							</Table.Body>
						</Table.Root>
						{#if subs.anyUnpriced}
							<p class="mt-3 text-xs text-muted-foreground">
								+ Some records had no known price, so the value is a lower bound.
							</p>
						{/if}
					</Card.Content>
				</Card.Root>
			</section>
		{:else}
			<p class="text-sm text-muted-foreground">
				No usage synced, {rangeLabel}. Sync an environment once it is online.
			</p>
		{/if}
	{/if}
</div>
