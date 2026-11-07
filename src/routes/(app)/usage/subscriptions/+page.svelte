<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import DailyStackedChart from '$lib/components/app/usage/DailyStackedChart.svelte';
	import EnvironmentCard from '$lib/components/app/usage/EnvironmentCard.svelte';
	import PlanLimitCard from '$lib/components/app/usage/PlanLimitCard.svelte';
	import PlanLimitBar from '$lib/components/app/usage/PlanLimitBar.svelte';
	import { subscriptionColor } from '$lib/components/app/usage/usage.js';
	import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';
	import { providerLabel } from '$lib/coding-environments.js';
	import { formatCount, formatSpend } from '$lib/formats.js';
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
	const days = $derived(data.periodDays);
	const plus = $derived(subs.anyUnpriced ? '+' : '');

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
			Usage included in your fixed-price plans (Claude, Codex, …), mirrored from your connected T3
			Code coding environments. Values are shown at API list prices for comparison — you are not
			billed per token.
		</p>

		<!-- Coding environments -->
		<section class="flex flex-col gap-3" aria-labelledby="envs-heading">
			<div class="flex items-center justify-between gap-2">
				<h2 id="envs-heading" class="text-base font-semibold">Coding environments</h2>
				<Button variant="ghost" size="sm" href={resolve('/settings/environments')}>Manage</Button>
			</div>
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each subs.environments as env (env.id)}
					<EnvironmentCard environment={env} {now} />
				{/each}
			</div>
		</section>

		<!-- Plan limits -->
		{#if subs.accounts.length > 0}
			<section class="flex flex-col gap-3" aria-labelledby="limits-heading">
				<h2 id="limits-heading" class="text-base font-semibold">Plan limits</h2>
				<div class="grid gap-3 md:grid-cols-2">
					{#each subs.accounts as account (account.key)}
						<PlanLimitCard {account} {now} />
					{/each}
				</div>
			</section>
		{/if}

		<!-- Usage by provider -->
		{#if subs.providers.length > 0}
			<section class="flex flex-col gap-3" aria-labelledby="providers-heading">
				<h2 id="providers-heading" class="text-base font-semibold">Usage by provider</h2>

				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{#each subs.providers as p (p.provider)}
						<!-- Anchor target for the Overview's "By provider" links. -->
						<Card.Root
							id="provider-{p.provider}"
							class="scroll-mt-4 rounded-2xl border-border/40 target:ring-2 target:ring-ring"
						>
							<Card.Content class="flex flex-col gap-1">
								<span class="flex items-center gap-2 text-sm text-muted-foreground">
									<span
										class="size-2.5 shrink-0 rounded-full"
										style:background-color={subscriptionColor(p.provider)}
									></span>
									{providerLabel(p.provider)}
								</span>
								<span class="text-2xl font-semibold tabular-nums">
									{formatSpend(p.costUsd)}{p.priced ? '' : '+'}
								</span>
								<span class="text-xs text-muted-foreground">API-equivalent value · not billed</span>
								<span class="text-xs text-muted-foreground tabular-nums">
									{formatCount(p.tokens)} tokens · {formatCount(p.sessions)}
									{p.sessions === 1 ? 'session' : 'sessions'}
								</span>
							</Card.Content>
						</Card.Root>
					{/each}
				</div>

				<Card.Root class="rounded-2xl border-border/40">
					<Card.Header class="flex flex-row flex-wrap items-start justify-between gap-3 pb-3">
						<div class="flex flex-col gap-1">
							<Card.Title class="text-sm font-medium">
								{metric === 'cost' ? 'API-equivalent value per day' : 'Tokens per day'}
							</Card.Title>
							<Card.Description>
								{#if metric === 'cost'}
									{formatSpend(subs.totalValueUsd)}{plus} API-equivalent value over {days} days — covered
									by your subscriptions, not billed per token.
								{:else}
									Input, cached and output tokens combined.
								{/if}
							</Card.Description>
						</div>
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
					</Card.Header>
					<Card.Content>
						<DailyStackedChart
							rows={chartRows}
							{series}
							valueFormat={metric === 'cost' ? formatSpend : formatCount}
							emptyText="No usage recorded in this period."
						/>
					</Card.Content>
				</Card.Root>

				<Card.Root class="rounded-2xl border-border/40">
					<Card.Header class="pb-3">
						<Card.Title class="text-sm font-medium">By model</Card.Title>
					</Card.Header>
					<Card.Content>
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head>Provider</Table.Head>
									<Table.Head>Model</Table.Head>
									<Table.Head class="text-right">Tokens</Table.Head>
									<Table.Head class="text-right">Sessions</Table.Head>
									<Table.Head class="text-right">API-equiv. value</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each subs.providers as p (p.provider)}
									{#each p.models as m (m.model)}
										<Table.Row>
											<Table.Cell>
												<span class="flex items-center gap-2 whitespace-nowrap">
													<span
														class="size-2 shrink-0 rounded-full"
														style:background-color={subscriptionColor(p.provider)}
													></span>
													{providerLabel(p.provider)}
												</span>
											</Table.Cell>
											<Table.Cell class="max-w-64 truncate font-mono text-xs" title={m.model}>
												{m.model}
											</Table.Cell>
											<Table.Cell class="text-right tabular-nums" title={m.tokens.toLocaleString()}>
												{formatCount(m.tokens)}
											</Table.Cell>
											<Table.Cell class="text-right tabular-nums"
												>{formatCount(m.sessions)}</Table.Cell
											>
											<Table.Cell
												class="text-right whitespace-nowrap text-muted-foreground tabular-nums"
											>
												≈ {formatSpend(m.costUsd)}{m.priced ? '' : '+'}
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
				No usage synced in the last {days} days. Sync an environment once it is online.
			</p>
		{/if}
	{/if}
</div>
