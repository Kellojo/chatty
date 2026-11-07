<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import TrendingDownIcon from '@lucide/svelte/icons/trending-down';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import DailyStackedChart from '$lib/components/app/usage/DailyStackedChart.svelte';
	import EnvironmentStatusChips from '$lib/components/app/usage/EnvironmentStatusChips.svelte';
	import PlanLimitBar from '$lib/components/app/usage/PlanLimitBar.svelte';
	import ProviderBillingBadge from '$lib/components/app/usage/ProviderBillingBadge.svelte';
	import UsageTile from '$lib/components/app/usage/UsageTile.svelte';
	import {
		mostUsedWindow,
		paygColor,
		periodQuery,
		subscriptionColor,
		type BillingType
	} from '$lib/components/app/usage/usage.js';
	import { providerLabel } from '$lib/coding-environments.js';
	import { formatCount, formatSpend } from '$lib/formats.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(id);
	});

	const payg = $derived(data.payg);
	const subs = $derived(data.subscriptions);
	const days = $derived(data.periodDays);
	const hasEnvironments = $derived(subs.environments.length > 0);
	const plus = $derived(subs.anyUnpriced ? '+' : '');

	/** Requests tab for the same period and scope as these numbers. */
	function requestsHref(extra: Record<string, string> = {}): string {
		return `${resolve('/usage/requests')}${periodQuery(data.period, { user: data.requestsUser, ...extra })}`;
	}
	const subscriptionsHref = $derived(
		`${resolve('/usage/subscriptions')}${periodQuery(data.period)}`
	);

	// ── pay-as-you-go ──
	const delta = $derived.by(() => {
		if (payg.previousRequests === 0) return null;
		const prev = payg.previousCostUsd;
		if (prev <= 0) return { pct: null, up: payg.totalCostUsd > 0 };
		const pct = Math.round(((payg.totalCostUsd - prev) / prev) * 100);
		return { pct, up: pct >= 0 };
	});
	const paygSeries = $derived(
		payg.providers.map((p) => ({ key: p.key, label: p.name, color: paygColor(p.colorSlot) }))
	);
	const paygRows = $derived(
		payg.dailyRows.map((row) => {
			const out: Record<string, string | number> = { day: row.day };
			for (const s of paygSeries) out[s.key] = Math.round((row.cost[s.key] ?? 0) * 10_000) / 10_000;
			return out;
		})
	);
	/** Requests were made but nothing was billed: a free or local model server. */
	const isFree = (p: { costUsd: number; requests: number }) => p.requests > 0 && p.costUsd === 0;

	// ── subscriptions ──
	const topWindow = $derived(mostUsedWindow(subs.accounts));
	const subSeries = $derived(
		subs.providers.map((p) => ({
			key: p.provider,
			label: providerLabel(p.provider),
			color: subscriptionColor(p.provider)
		}))
	);
	const subRows = $derived(
		subs.dailyRows.map((row) => {
			const out: Record<string, string | number> = { day: row.day };
			for (const s of subSeries) out[s.key] = Math.round((row.cost[s.key] ?? 0) * 100) / 100;
			return out;
		})
	);

	// ── merged provider table: both sources side by side, never summed ──
	interface ProviderRow {
		key: string;
		billing: BillingType;
		name: string;
		color: string;
		tokens: number;
		count: number;
		countLabel: string;
		costUsd: number;
		priced: boolean;
		free: boolean;
		href: string;
	}
	const providerRows = $derived<ProviderRow[]>([
		...payg.providers.map((p) => ({
			key: `payg:${p.key}`,
			billing: 'payg' as const,
			name: p.name,
			color: paygColor(p.colorSlot),
			tokens: p.inputTokens + p.outputTokens,
			count: p.requests,
			countLabel: p.requests === 1 ? 'request' : 'requests',
			costUsd: p.costUsd,
			priced: true,
			free: isFree(p),
			href: requestsHref({ provider: p.providerId ?? '' })
		})),
		...subs.providers.map((p) => ({
			key: `sub:${p.provider}`,
			billing: 'subscription' as const,
			name: providerLabel(p.provider),
			color: subscriptionColor(p.provider),
			tokens: p.tokens,
			count: p.sessions,
			countLabel: p.sessions === 1 ? 'session' : 'sessions',
			costUsd: p.costUsd,
			priced: p.priced,
			free: false,
			href: `${subscriptionsHref}#provider-${p.provider}`
		}))
	]);
</script>

<svelte:head><title>Usage · Chatty</title></svelte:head>

<!-- hrefs below are built from resolve() plus a query string / hash. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<div class="flex flex-col gap-6">
	<div class="flex flex-col gap-2">
		<p class="text-sm text-muted-foreground">
			Your usage over the last {days} days. What you were billed and what your subscriptions covered are
			shown side by side and never added together.
		</p>
		<EnvironmentStatusChips environments={subs.environments} {now} />
	</div>

	<!-- Headline: actual spend vs. subscription value. The badge is the only type marker. -->
	<div class="grid gap-3 md:grid-cols-2">
		<UsageTile
			billing="payg"
			label="Spend"
			value={formatSpend(payg.totalCostUsd)}
			subtitle="Billed per token by the providers configured in Chatty."
		>
			<span class="text-sm text-foreground/80 tabular-nums">
				{formatCount(payg.totalTokens)} tokens · {formatCount(payg.totalRequests)}
				{payg.totalRequests === 1 ? 'request' : 'requests'}
			</span>
			{#if delta}
				<span class="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
					{#if delta.up}
						<TrendingUpIcon class="size-3.5" aria-hidden="true" />
					{:else}
						<TrendingDownIcon class="size-3.5" aria-hidden="true" />
					{/if}
					{#if delta.pct === null}
						{formatSpend(payg.previousCostUsd)} in the previous {days} days
					{:else}
						{delta.pct > 0 ? '+' : ''}{delta.pct}% vs previous {days} days ({formatSpend(
							payg.previousCostUsd
						)})
					{/if}
				</span>
			{/if}
		</UsageTile>

		{#if hasEnvironments}
			<UsageTile
				billing="subscription"
				label="Value used"
				value="{formatSpend(subs.totalValueUsd)}{plus}"
				subtitle="Included in your plans, shown at API prices — not billed."
			>
				<span class="text-sm text-foreground/80 tabular-nums">
					{formatCount(subs.totalTokens)} tokens · {formatCount(subs.totalSessions)}
					{subs.totalSessions === 1 ? 'session' : 'sessions'}
				</span>
				{#if topWindow}
					<PlanLimitBar
						window={topWindow.window}
						label="{topWindow.account.accountLabel} · {topWindow.window.windowLabel}"
						ariaLabel="Most-used plan limit: {topWindow.account.accountLabel} {topWindow.window
							.windowLabel}"
						{now}
					/>
				{/if}
			</UsageTile>
		{:else}
			<!-- The one connect call-to-action on this page. -->
			<Card.Root class="rounded-2xl border-dashed border-border/60">
				<Card.Content class="flex h-full flex-col items-start gap-2">
					<div class="flex w-full flex-wrap items-center justify-between gap-2">
						<span class="text-sm text-muted-foreground">Value used</span>
						<ProviderBillingBadge billing="subscription" />
					</div>
					<p class="text-sm text-muted-foreground">
						Connect a T3 Code coding environment to track your Claude, Codex and other plans:
						limits, resets and the API-equivalent value of what you use. Chatty never bills for it.
					</p>
					<Button size="sm" class="mt-auto" href={resolve('/settings/environments')}>
						Connect environment
					</Button>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>

	<div class="grid gap-4 {hasEnvironments ? 'lg:grid-cols-2' : ''}">
		<!-- Pay-as-you-go column -->
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Header class="pb-3">
				<Card.Title class="flex flex-wrap items-center gap-2 text-sm font-medium">
					Daily cost
					<ProviderBillingBadge billing="payg" />
				</Card.Title>
				<Card.Description>Actual cost per day, by provider.</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-1 flex-col gap-4">
				{#if payg.providers.length === 0}
					<p class="py-6 text-center text-sm text-muted-foreground">
						No requests in the last {days} days.
					</p>
				{:else}
					<DailyStackedChart
						rows={paygRows}
						series={paygSeries}
						valueFormat={formatSpend}
						emptyText="No billable spend in this period."
					/>
					<ul class="flex flex-col gap-2" aria-label="Top providers by cost">
						{#each payg.providers.slice(0, 5) as p (p.key)}
							<li class="flex items-center gap-2 text-sm">
								<span
									class="size-2.5 shrink-0 rounded-full"
									style:background-color={paygColor(p.colorSlot)}
								></span>
								<span class="min-w-0 flex-1 truncate" title={p.name}>{p.name}</span>
								{#if isFree(p)}
									<span class="text-xs text-muted-foreground">free / local</span>
								{:else if payg.totalCostUsd > 0}
									<span class="text-xs text-muted-foreground tabular-nums">
										{Math.round((p.costUsd / payg.totalCostUsd) * 100)}%
									</span>
								{/if}
								<span class="w-20 text-right font-medium tabular-nums"
									>{formatSpend(p.costUsd)}</span
								>
							</li>
						{/each}
					</ul>
				{/if}
				<a
					href={requestsHref()}
					class="mt-auto inline-flex items-center gap-1 self-start text-sm font-medium underline-offset-4 hover:underline"
				>
					View requests <ArrowRightIcon class="size-3.5" aria-hidden="true" />
				</a>
			</Card.Content>
		</Card.Root>

		<!-- Subscriptions column: only once something is connected -->
		{#if hasEnvironments}
			<Card.Root class="rounded-2xl border-border/40">
				<Card.Header class="pb-3">
					<Card.Title class="flex flex-wrap items-center gap-2 text-sm font-medium">
						Plan limits
						<ProviderBillingBadge billing="subscription" />
					</Card.Title>
					<Card.Description>Where each plan stands, and its value per day.</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-1 flex-col gap-4">
					{#if subs.accounts.length > 0}
						<div class="flex flex-col gap-4">
							{#each subs.accounts as account (account.key)}
								<div class="flex flex-col gap-2">
									<span class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
										<span
											class="size-2 shrink-0 rounded-full"
											style:background-color={subscriptionColor(account.provider)}
										></span>
										<span class="truncate">
											{account.accountLabel}{account.accountPlan ? ` · ${account.accountPlan}` : ''}
										</span>
									</span>
									{#each account.windows as w (w.windowId)}
										<PlanLimitBar
											window={w}
											ariaLabel="{account.accountLabel} {w.windowLabel}"
											{now}
										/>
									{/each}
								</div>
							{/each}
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">No plan limits reported yet.</p>
					{/if}
					<div class="flex flex-col gap-1">
						<span class="text-xs text-muted-foreground">API-equivalent value per day</span>
						<DailyStackedChart
							rows={subRows}
							series={subSeries}
							valueFormat={formatSpend}
							emptyText="No subscription usage synced in this period."
							class="max-h-[160px] min-h-[160px]"
						/>
					</div>
					<a
						href={subscriptionsHref}
						class="mt-auto inline-flex items-center gap-1 self-start text-sm font-medium underline-offset-4 hover:underline"
					>
						View details <ArrowRightIcon class="size-3.5" aria-hidden="true" />
					</a>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>

	<!-- One table for both sources; billed and API value stay in separate columns. -->
	<section class="flex flex-col gap-3" aria-labelledby="by-provider-heading">
		<div class="flex flex-col gap-0.5">
			<h2 id="by-provider-heading" class="text-base font-semibold">By provider</h2>
			<p class="text-sm text-muted-foreground">
				"Billed" is what you paid; "API value" is what your subscriptions covered. Select a provider
				for details.
			</p>
		</div>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content>
				{#if providerRows.length === 0}
					<p class="py-6 text-center text-sm text-muted-foreground">
						No usage in the last {days} days.
					</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Provider</Table.Head>
								<Table.Head>Billing</Table.Head>
								<Table.Head class="text-right">Tokens</Table.Head>
								<Table.Head class="text-right">Volume</Table.Head>
								<Table.Head class="text-right">Billed</Table.Head>
								<Table.Head class="text-right">API value</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each providerRows as row (row.key)}
								<Table.Row>
									<Table.Cell>
										<a
											href={row.href}
											class="group inline-flex max-w-56 items-center gap-2 font-medium underline-offset-4 hover:underline"
										>
											<span class="size-2 shrink-0 rounded-full" style:background-color={row.color}
											></span>
											<span class="truncate" title={row.name}>{row.name}</span>
											<ChevronRightIcon
												class="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
												aria-hidden="true"
											/>
										</a>
									</Table.Cell>
									<Table.Cell><ProviderBillingBadge billing={row.billing} /></Table.Cell>
									<Table.Cell class="text-right tabular-nums" title={row.tokens.toLocaleString()}>
										{formatCount(row.tokens)}
									</Table.Cell>
									<Table.Cell class="text-right whitespace-nowrap tabular-nums">
										{formatCount(row.count)}
										<span class="text-muted-foreground">{row.countLabel}</span>
									</Table.Cell>
									<Table.Cell class="text-right whitespace-nowrap tabular-nums">
										{#if row.billing === 'payg'}
											<span class="font-medium">{formatSpend(row.costUsd)}</span>
											{#if row.free}
												<span class="block text-xs text-muted-foreground">free / local</span>
											{/if}
										{:else}
											<span class="text-muted-foreground" aria-label="not billed">—</span>
										{/if}
									</Table.Cell>
									<Table.Cell class="text-right whitespace-nowrap tabular-nums">
										{#if row.billing === 'subscription'}
											<span
												class="text-muted-foreground"
												title="API-equivalent value — covered by your plan, not billed"
											>
												≈ {formatSpend(row.costUsd)}{row.priced ? '' : '+'}
											</span>
										{:else}
											<span class="text-muted-foreground" aria-label="not applicable">—</span>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
					{#if subs.anyUnpriced}
						<p class="mt-3 text-xs text-muted-foreground">
							+ Some subscription records had no known price, so the value is a lower bound.
						</p>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>
	</section>
</div>
