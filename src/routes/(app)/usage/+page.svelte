<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ReceiptIcon from '@lucide/svelte/icons/receipt';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
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
		formatApiValue,
		mostUsedWindow,
		remainingPercent,
		paygColor,
		NO_COST_REPORTED,
		formatBilled,
		rangeQuery,
		subscriptionColor,
		type BillingType
	} from '$lib/components/app/usage/usage.js';
	import { providerLabel } from '$lib/coding-environments.js';
	import { formatCount, formatSpend, formatSpendCompact } from '$lib/formats.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(id);
	});

	const payg = $derived(data.payg);
	const subs = $derived(data.subscriptions);
	const rangeLabel = $derived(data.rangeLabel);
	const hasEnvironments = $derived(subs.environments.length > 0);

	/** Requests tab for the same period and scope as these numbers. */
	function requestsHref(extra: Record<string, string> = {}): string {
		return `${resolve('/usage/requests')}${rangeQuery(data.rangeParams, { user: data.requestsUser, ...extra })}`;
	}
	const subscriptionsHref = $derived(
		`${resolve('/usage/subscriptions')}${rangeQuery(data.rangeParams)}`
	);

	// ── pay-as-you-go ──
	const delta = $derived.by(() => {
		// Only compare billed amounts that both periods actually reported.
		if (!payg.previous || payg.previous.pricedRequests === 0 || payg.pricedRequests === 0)
			return null;
		const prev = payg.previous.costUsd;
		if (prev <= 0) return { pct: null, up: payg.totalCostUsd > 0 };
		const pct = Math.round(((payg.totalCostUsd - prev) / prev) * 100);
		return { pct, up: pct >= 0 };
	});
	const paygSeries = $derived(
		payg.providers.map((p) => ({ key: p.key, label: p.name, color: paygColor(p.colorSlot) }))
	);
	// With nothing billed, chart requests instead of a row of $0s.
	const paygAllFree = $derived(payg.totalCostUsd === 0 && payg.totalRequests > 0);
	const paygRows = $derived(
		payg.dailyRows.map((row) => {
			const out: Record<string, string | number> = { day: row.day };
			for (const s of paygSeries)
				out[s.key] = paygAllFree
					? (row.requests[s.key] ?? 0)
					: Math.round((row.cost[s.key] ?? 0) * 10_000) / 10_000;
			return out;
		})
	);
	/** No request reported a cost: the price is unknown (same rule as the request log). */
	const noCost = (p: { pricedRequests: number }) => p.pricedRequests === 0;

	// ── subscriptions ──
	const topWindow = $derived(mostUsedWindow(subs.accounts, now));
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
		pricedRequests: number;
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
			pricedRequests: p.pricedRequests,
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
			pricedRequests: 0,
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
			Your usage, {rangeLabel}. What you were billed and what your subscriptions covered are shown
			side by side and never added together.
		</p>
		<EnvironmentStatusChips environments={subs.environments} {now} />
	</div>

	<!-- Headline: actual spend vs. subscription value. The badge is the only type marker. -->
	<div class="grid gap-3 md:grid-cols-2">
		<UsageTile
			billing="payg"
			label="Billed"
			value={payg.totalRequests === 0
				? formatBilled(0)
				: formatBilled(payg.totalCostUsd, { pricedRequests: payg.pricedRequests })}
			caption={payg.totalRequests > 0 && payg.pricedRequests === 0 ? 'No cost reported' : undefined}
			subtitle="Billed per token by the providers configured in Chatty."
		>
			<span class="text-sm text-foreground/80 tabular-nums">
				{#if payg.totalRequests === 0}
					No requests in this period
				{:else}
					Your {formatCount(payg.totalRequests)}
					{payg.totalRequests === 1 ? 'request' : 'requests'} · {formatCount(payg.totalTokens)} tokens
				{/if}
			</span>
			{#if delta}
				<span class="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
					{#if delta.up}
						<TrendingUpIcon class="size-3.5" aria-hidden="true" />
					{:else}
						<TrendingDownIcon class="size-3.5" aria-hidden="true" />
					{/if}
					{#if delta.pct === null}
						{formatBilled(payg.previous?.costUsd ?? 0)} in the previous period
					{:else}
						{delta.pct > 0 ? '+' : ''}{delta.pct}% vs previous period ({formatBilled(
							payg.previous?.costUsd ?? 0
						)})
					{/if}
				</span>
			{/if}
			{#if payg.pricedRequests > 0 && payg.pricedRequests < payg.totalRequests}
				<span class="text-xs text-muted-foreground tabular-nums">
					{formatCount(payg.totalRequests - payg.pricedRequests)} without a reported cost
				</span>
			{/if}
		</UsageTile>

		{#if hasEnvironments}
			<UsageTile
				billing="subscription"
				label="API value"
				value={formatApiValue(subs.totalValueUsd, subs.anyUnpriced)}
				subtitle="Included in your plans, shown at API prices — not billed."
			>
				<span class="text-sm text-foreground/80 tabular-nums">
					{#if subs.totalSessions === 0}
						No sessions in this period
					{:else}
						Your {formatCount(subs.totalSessions)}
						{subs.totalSessions === 1 ? 'session' : 'sessions'} · {formatCount(subs.totalTokens)} tokens
					{/if}
				</span>
				{#if topWindow}
					<span class="text-xs text-muted-foreground tabular-nums">
						Lowest remaining: {topWindow.account.accountLabel}
						{topWindow.window.windowLabel.toLowerCase()} · {remainingPercent(topWindow.window)}%
						left
					</span>
				{/if}
			</UsageTile>
		{:else}
			<!-- The one connect call-to-action on this page. -->
			<Card.Root class="rounded-2xl border-dashed border-border/60">
				<Card.Content class="flex h-full flex-col items-start gap-2">
					<div class="flex w-full flex-wrap items-center justify-between gap-2">
						<span class="text-sm text-muted-foreground">API value</span>
						<ProviderBillingBadge billing="subscription" />
					</div>
					<p class="text-sm text-muted-foreground">
						Connect a T3 Code coding environment to track your Claude, Codex and other plans:
						limits, resets and the API-equivalent value of what you use. Chatty never bills for it.
					</p>
					<Button
						variant="outline"
						size="sm"
						class="mt-auto"
						href={resolve('/settings/environments')}
					>
						Connect environment
					</Button>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>

	<!-- Plan limits: their own full-width strip, so the chart columns below mirror each other. -->
	{#if hasEnvironments && subs.accounts.length > 0}
		<Card.Root class="gap-3 rounded-2xl border-border/40">
			<Card.Header>
				<Card.Title class="flex flex-wrap items-center gap-2 text-sm font-medium">
					Plan limits
					<ProviderBillingBadge billing="subscription" />
				</Card.Title>
			</Card.Header>
			<Card.Content>
				<div class="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-x-8 gap-y-5">
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
								<PlanLimitBar window={w} ariaLabel="{account.accountLabel} {w.windowLabel}" {now} />
							{/each}
						</div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- Mirrored columns: daily chart → provider list → drill-down link. -->
	<!-- Equal heights, with the drill-down links pinned to the bottom of both cards. -->
	<div class="grid gap-4 {hasEnvironments ? 'lg:grid-cols-2' : ''}">
		<!-- No requests of your own: one clear empty state instead of an empty chart and list. -->
		{#if payg.totalRequests === 0}
			<Card.Root class="h-full rounded-2xl border-border/40">
				<EmptyState
					icon={ReceiptIcon}
					title="No requests from you in this period"
					description="Chats and agent runs you start show up here with what they cost."
				>
					{#if data.user.role === 'admin'}
						<Button variant="outline" href={requestsHref()}>
							See everyone's requests <ArrowRightIcon />
						</Button>
					{/if}
				</EmptyState>
			</Card.Root>
		{:else}
			<Card.Root class="h-full rounded-2xl border-border/40">
				<Card.Header class="pb-3">
					<Card.Title class="flex flex-wrap items-center gap-2 text-sm font-medium">
						{paygAllFree ? 'Requests per day' : 'Billed per day'}
						<ProviderBillingBadge billing="payg" />
					</Card.Title>
					<Card.Description>
						{#if paygAllFree}
							Nothing was billed {rangeLabel}, so this shows requests per day.
						{:else}
							Billed cost per day, by provider{payg.chartCapped ? ' (most recent 365 days)' : ''}.
						{/if}
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-1 flex-col gap-4">
					{#if payg.providers.length === 0}
						<p class="text-sm text-muted-foreground">No requests, {rangeLabel}.</p>
					{:else}
						<DailyStackedChart
							rows={paygRows}
							series={paygSeries}
							valueFormat={paygAllFree ? formatCount : formatSpend}
							axisFormat={paygAllFree ? formatCount : formatSpendCompact}
							class="max-h-[200px] min-h-[200px]"
						/>
						<ul class="flex flex-col gap-2" aria-label="Pay-as-you-go providers">
							{#each payg.providers.slice(0, 5) as p (p.key)}
								<li class="flex items-center gap-2 text-sm">
									<span
										class="size-2.5 shrink-0 rounded-full"
										style:background-color={paygColor(p.colorSlot)}
									></span>
									<span class="min-w-0 flex-1 truncate" title={p.name}>{p.name}</span>
									{#if noCost(p)}
										<span class="text-xs text-muted-foreground" title={NO_COST_REPORTED}
											>no cost reported</span
										>
									{:else if payg.totalCostUsd > 0}
										<span class="text-xs text-muted-foreground tabular-nums">
											{Math.round((p.costUsd / payg.totalCostUsd) * 100)}%
										</span>
									{/if}
									<span class="w-24 text-right font-medium tabular-nums"
										>{formatBilled(p.costUsd, { pricedRequests: p.pricedRequests })}</span
									>
								</li>
							{/each}
						</ul>
					{/if}
					<a
						href={requestsHref()}
						class="mt-auto inline-flex items-center gap-1 self-start text-sm font-medium underline-offset-4 hover:underline pointer-coarse:min-h-10"
					>
						View your requests <ArrowRightIcon class="size-3.5" aria-hidden="true" />
					</a>
				</Card.Content>
			</Card.Root>
		{/if}

		{#if hasEnvironments}
			<Card.Root class="h-full rounded-2xl border-border/40">
				<Card.Header class="pb-3">
					<Card.Title class="flex flex-wrap items-center gap-2 text-sm font-medium">
						Daily value
						<ProviderBillingBadge billing="subscription" />
					</Card.Title>
					<Card.Description>
						API value per day, by provider.{subs.note ? ` ${subs.note}` : ''}
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-1 flex-col gap-4">
					{#if subs.providers.length === 0}
						<p class="text-sm text-muted-foreground">
							No subscription usage synced, {rangeLabel}.
						</p>
					{:else}
						<DailyStackedChart
							rows={subRows}
							series={subSeries}
							valueFormat={formatSpend}
							axisFormat={formatSpendCompact}
							emptyText="No priced subscription usage in this period."
							class="max-h-[200px] min-h-[200px]"
						/>
						<ul class="flex flex-col gap-2" aria-label="Subscription providers">
							{#each subs.providers.slice(0, 5) as p (p.provider)}
								<li class="flex items-center gap-2 text-sm">
									<span
										class="size-2.5 shrink-0 rounded-full"
										style:background-color={subscriptionColor(p.provider)}
									></span>
									<span class="min-w-0 flex-1 truncate">{providerLabel(p.provider)}</span>
									<span class="text-xs text-muted-foreground tabular-nums">
										{formatCount(p.tokens)} tokens
									</span>
									<span class="w-24 text-right text-muted-foreground tabular-nums">
										{formatApiValue(p.costUsd, !p.priced)}
									</span>
								</li>
							{/each}
						</ul>
					{/if}
					<a
						href={subscriptionsHref}
						class="mt-auto inline-flex items-center gap-1 self-start text-sm font-medium underline-offset-4 hover:underline pointer-coarse:min-h-10"
					>
						View details <ArrowRightIcon class="size-3.5" aria-hidden="true" />
					</a>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>

	<!-- One table for both sources; billed and API value stay in separate columns.
	     Nothing to break down without usage; the cards above already say so. -->
	{#if providerRows.length > 0}
		<section class="flex flex-col gap-3" aria-labelledby="by-provider-heading">
			<div class="flex flex-col gap-0.5">
				<h2 id="by-provider-heading" class="text-base font-semibold">By provider</h2>
				<p class="text-sm text-muted-foreground">
					"Billed" is what you paid; "API value" is what your subscriptions covered. Select a
					provider for details.
				</p>
			</div>
			<Card.Root class="rounded-2xl border-border/40">
				<Card.Content>
					{#if providerRows.length === 0}
						<p class="py-6 text-center text-sm text-muted-foreground">
							No usage, {rangeLabel}.
						</p>
					{:else}
						<!-- Phones: one stacked item per provider instead of a sideways-scrolling table. -->
						<ul class="flex flex-col divide-y divide-border/60 md:hidden">
							{#each providerRows as row (row.key)}
								<li>
									<a href={row.href} class="flex flex-col gap-1 py-3">
										<span class="flex items-center gap-2">
											<span class="size-2 shrink-0 rounded-full" style:background-color={row.color}
											></span>
											<span class="min-w-0 flex-1 truncate font-medium">{row.name}</span>
											<ProviderBillingBadge billing={row.billing} />
										</span>
										<span class="flex items-baseline gap-2 pl-4 text-xs text-muted-foreground">
											<span class="min-w-0 flex-1 truncate tabular-nums">
												{formatCount(row.tokens)} tokens · {formatCount(row.count)}
												{row.countLabel}{row.billing === 'payg' && row.pricedRequests === 0
													? ' · no cost reported'
													: ''}
											</span>
											{#if row.billing === 'payg'}
												{#if row.pricedRequests > 0}
													<span class="text-sm font-medium text-foreground tabular-nums">
														{formatBilled(row.costUsd, { pricedRequests: row.pricedRequests })}
													</span>
												{/if}
											{:else}
												<span class="text-sm tabular-nums">
													{formatApiValue(row.costUsd, !row.priced)}
												</span>
											{/if}
										</span>
									</a>
								</li>
							{/each}
						</ul>
						<div class="hidden md:block">
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
													<span
														class="size-2 shrink-0 rounded-full"
														style:background-color={row.color}
													></span>
													<span class="truncate" title={row.name}>{row.name}</span>
													<ChevronRightIcon
														class="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
														aria-hidden="true"
													/>
												</a>
											</Table.Cell>
											<Table.Cell><ProviderBillingBadge billing={row.billing} /></Table.Cell>
											<Table.Cell
												class="text-right tabular-nums"
												title={row.tokens.toLocaleString()}
											>
												{formatCount(row.tokens)}
											</Table.Cell>
											<Table.Cell class="text-right whitespace-nowrap tabular-nums">
												{formatCount(row.count)}
												<span class="text-muted-foreground">{row.countLabel}</span>
											</Table.Cell>
											<Table.Cell class="text-right whitespace-nowrap tabular-nums">
												{#if row.billing === 'payg'}
													<span
														class="font-medium"
														title={row.pricedRequests === 0 ? NO_COST_REPORTED : undefined}
													>
														{formatBilled(row.costUsd, { pricedRequests: row.pricedRequests })}
													</span>
												{:else}
													<!-- "—" is reserved for "no cost reported"; subscriptions are prepaid. -->
													<span
														class="text-muted-foreground"
														title="Included in your plan — not billed per token"
													>
														Included
													</span>
												{/if}
											</Table.Cell>
											<Table.Cell class="text-right whitespace-nowrap tabular-nums">
												{#if row.billing === 'subscription'}
													<span
														class="text-muted-foreground"
														title="API-equivalent value — covered by your plan, not billed"
													>
														{formatApiValue(row.costUsd, !row.priced)}
													</span>
												{:else}
													<span class="sr-only">Not applicable</span>
												{/if}
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
						{#if subs.anyUnpriced}
							<p class="mt-3 text-xs text-muted-foreground">
								+ Some subscription records had no known price, so the value is a lower bound.
							</p>
						{/if}
					{/if}
				</Card.Content>
			</Card.Root>
		</section>
	{/if}
</div>
