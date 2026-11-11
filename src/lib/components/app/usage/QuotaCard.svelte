<script lang="ts">
	import TicketIcon from '@lucide/svelte/icons/ticket';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Card from '$lib/components/ui/card/index.js';
	import { providerLabel } from '$lib/coding-environments.js';
	import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';
	import { formatTimeAgo } from '$lib/datetime.js';
	import QuotaChart from './QuotaChart.svelte';
	import {
		formatBurndownTime,
		formatDuration,
		limitHistoryKey,
		type BurndownRange,
		type LimitHistorySample
	} from './burndown.js';
	import { buildQuotaPool, upcomingResets } from './quota.js';
	import { subscriptionColor, type UsageAccount } from './usage.js';

	// One provider's plan limits across its accounts: what is left of the main (longest)
	// limit, where today's burn rate leads through future resets, any extra resets on hand,
	// and every scheduled reset coming up.
	let {
		provider,
		accounts,
		history,
		range = {},
		now
	}: {
		provider: string;
		accounts: UsageAccount[];
		/** Synced readings per window, keyed by `limitHistoryKey`. */
		history: Record<string, LimitHistorySample[]>;
		/** The selected time range the chart's recorded part covers. */
		range?: BurndownRange;
		now: number;
	} = $props();

	const DAY = 86_400_000;
	const KIND_RANK = { session: 0, other: 1, weekly: 2, monthly: 3 } as const;
	const mainWindow = (a: UsageAccount): CodingUsageLimitWindow =>
		a.windows.reduce((best, w) =>
			KIND_RANK[w.windowKind] > KIND_RANK[best.windowKind] ? w : best
		);

	const color = $derived(subscriptionColor(provider));
	const multi = $derived(accounts.length > 1);
	const main = $derived(accounts.map((a) => ({ account: a, window: mainWindow(a) })));
	const mainLabel = $derived(main[0].window.windowLabel);
	const pool = $derived(
		buildQuotaPool(
			main.map(({ account, window }) => ({
				key: account.key,
				label: account.accountLabel,
				window,
				history: history[limitHistoryKey(window)] ?? []
			})),
			now,
			range
		)
	);
	// The projection starts at the last reading, so a reset since then is already past.
	const nextReset = $derived(pool.resets.find((r) => r.at > now) ?? null);
	// Running dry before the next refill is the one thing worth flagging.
	const runsDryEarly = $derived(
		pool.emptyAt !== null && (nextReset === null || pool.emptyAt < nextReset.at)
	);
	const resets = $derived(
		upcomingResets(
			accounts.flatMap((a) =>
				a.windows.map((window) => ({ accountLabel: a.accountLabel, window }))
			),
			now
		)
	);

	// Extra resets on hand (redeemable in T3 Code), soonest expiry first.
	const credits = $derived(
		accounts
			.filter((a) => (a.resetCredits?.availableCount ?? 0) > 0)
			.map((a) => ({
				key: a.key,
				label: a.accountLabel,
				count: a.resetCredits!.availableCount,
				expiresAt: a.resetCredits!.nextExpiresAt
			}))
			.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
	);
	// Worth redeeming now: an account with extra resets runs dry before its own reset.
	const redeemHint = $derived.by(() => {
		for (const e of pool.emptyEarly) {
			const credit = accounts.find((a) => a.key === e.key)?.resetCredits;
			if (credit?.availableCount) return { ...e, expiresAt: credit.nextExpiresAt };
		}
		return null;
	});
	// The window to redeem in closes at the account's reset or when its credit lapses.
	const redeemBy = $derived.by(() => {
		if (!redeemHint) return null;
		const ends = [redeemHint.resetAt, redeemHint.expiresAt].filter((t): t is number => t !== null);
		return ends.length ? Math.min(...ends) : null;
	});
	const creditCount = $derived(credits.reduce((sum, c) => sum + c.count, 0));
	const creditExpiry = $derived(credits.find((c) => c.expiresAt !== null)?.expiresAt ?? null);
	// Amber within three days of the first one lapsing, red on its last day.
	// The reset that lapses first, when it is close and the redeem hint isn't about it
	// already: say it will go unused unless redeemed in time.
	const lapsing = $derived.by(() => {
		const first = credits[0];
		if (!first || first.expiresAt === null || first.expiresAt - now > 3 * DAY) return null;
		return redeemHint?.key === first.key ? null : first;
	});
	const creditUrgency = $derived(
		creditExpiry === null || creditExpiry - now > 3 * DAY
			? 'calm'
			: creditExpiry - now > DAY
				? 'soon'
				: 'today'
	);

	const checkedAt = $derived(Math.max(...accounts.map((a) => a.checkedAt)));
	// Weekday and time; the date too once it is far enough out for the weekday to repeat.
	const time = (at: number) => formatBurndownTime(at, Math.abs(at - now) > 6 * DAY ? 9 * DAY : 0);
	const summary = $derived(
		`${providerLabel(provider)} ${mainLabel}: ${Math.round(pool.remaining)}% left of ${pool.capacity}%` +
			(pool.emptyAt !== null ? `, runs out ${time(pool.emptyAt)} at this rate` : '') +
			(nextReset
				? `, next reset ${time(nextReset.at)} gives back ${Math.round(nextReset.gain)}%`
				: '')
	);
</script>

<Card.Root class="rounded-2xl border-border/40">
	<Card.Content class="flex flex-col gap-5">
		<!-- Headline: what is left, then the numbers that say how long it lasts. -->
		<div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-16">
			<div class="flex shrink-0 flex-col gap-1">
				<span class="flex items-center gap-2 text-sm text-muted-foreground">
					<span class="size-2.5 shrink-0 rounded-full" style:background-color={color}></span>
					<span class="font-medium text-foreground">{providerLabel(provider)}</span>
					{#if multi}
						· {accounts.length} accounts
					{:else if accounts[0].accountPlan}
						· {accounts[0].accountPlan}
					{/if}
					· {mainLabel.toLowerCase()} limit
				</span>
				<span class="flex items-baseline gap-2">
					<span class="text-4xl font-semibold tracking-tight tabular-nums"
						>{Math.round(pool.remaining)}%</span
					>
					<span class="text-sm text-muted-foreground">
						{multi ? `left of ${pool.capacity}%` : 'left'}
					</span>
				</span>
			</div>

			<!-- Value on top, its context below, so the three stats line up at any width. -->
			<dl class="grid grid-cols-[1.4fr_1fr_1fr] gap-x-4 gap-y-3 text-sm sm:grid-cols-3 sm:gap-x-12">
				<div class="flex flex-col">
					<!-- Several accounts pool their limits: say which empty-time this is. -->
					<dt class="text-xs text-muted-foreground">{multi ? 'Pool empty' : 'Runs out'}</dt>
					<dd class="font-medium tabular-nums {runsDryEarly ? 'text-destructive' : ''}">
						{#if pool.emptyAt !== null}
							{#if runsDryEarly}
								<TriangleAlertIcon class="mr-0.5 inline size-3.5 align-[-2px]" aria-hidden="true" />
							{/if}
							{time(pool.emptyAt)}
						{:else if pool.projected.length}
							<span class="text-muted-foreground">Not at this rate</span>
						{:else}
							<span class="text-muted-foreground">—</span>
						{/if}
					</dd>
					{#if multi && pool.firstEmptyAt !== null && pool.firstEmptyAt !== pool.emptyAt}
						<!-- An account running dry before its reset matters even when the pool lasts. -->
						<dd
							class="text-xs tabular-nums {pool.emptyEarly.length
								? 'font-medium text-destructive'
								: 'text-muted-foreground'}"
						>
							{#if pool.emptyEarly.length}
								<TriangleAlertIcon class="mr-0.5 inline size-3 align-[-1px]" aria-hidden="true" />
							{/if}
							{pool.emptyEarly.length > 1
								? `${pool.emptyEarly.length} accounts run dry first`
								: `first account ${time(pool.firstEmptyAt)}`}
						</dd>
					{/if}
				</div>
				<div class="flex flex-col">
					<dt class="text-xs text-muted-foreground">{mainLabel} reset</dt>
					{#if nextReset}
						<dd class="font-medium tabular-nums">+{Math.round(nextReset.gain)}%</dd>
						<dd class="text-xs text-muted-foreground tabular-nums">{time(nextReset.at)}</dd>
					{:else}
						<dd class="text-muted-foreground">—</dd>
					{/if}
				</div>
				<div class="flex flex-col">
					<dt class="text-xs text-muted-foreground">Burn rate</dt>
					{#if pool.burnPerHour !== null}
						<dd class="font-medium tabular-nums">{pool.burnPerHour.toFixed(1)}%/h</dd>
						<dd class="text-xs text-muted-foreground">
							avg this {mainLabel === 'Weekly' ? 'week' : 'window'}
						</dd>
					{:else}
						<dd class="text-muted-foreground">—</dd>
					{/if}
				</div>
			</dl>
		</div>

		{#if creditCount > 0}
			<!-- Extra resets on hand: easy to forget and they lapse, so they stand out. -->
			<div
				class="flex items-start gap-3 rounded-xl border px-3 py-2.5 text-sm {creditUrgency ===
				'today'
					? 'border-destructive/40 bg-destructive/10'
					: creditUrgency === 'soon'
						? 'border-amber-500/40 bg-amber-500/10'
						: 'border-dashed border-border'}"
				role="status"
			>
				<TicketIcon
					class="mt-0.5 size-4 shrink-0 {creditUrgency === 'today'
						? 'text-destructive'
						: creditUrgency === 'soon'
							? 'text-amber-600 dark:text-amber-400'
							: 'text-muted-foreground'}"
					aria-hidden="true"
				/>
				<div class="flex min-w-0 flex-col gap-0.5">
					<span>
						<span class="font-medium"
							>{creditCount} extra {creditCount === 1 ? 'reset' : 'resets'} available</span
						>
						{#if creditExpiry !== null}
							<span
								class={creditUrgency === 'today'
									? 'font-medium text-destructive'
									: creditUrgency === 'soon'
										? 'font-medium text-foreground'
										: 'text-muted-foreground'}
							>
								· {creditCount > 1 ? 'first expires' : 'expires'} in
								{formatDuration(creditExpiry - now)}{multi && credits[0]
									? ` on “${credits[0].label}”`
									: ''}{redeemHint || lapsing ? '' : ` (${time(creditExpiry)})`}
							</span>
						{/if}
						{#if multi && credits.length > 1 && !redeemHint && !lapsing}
							<span class="text-muted-foreground">
								· {credits.map((c) => `${c.count} on “${c.label}”`).join(', ')}
							</span>
						{/if}
					</span>
					<!-- The deadline that coloured the callout comes first. -->
					{#if lapsing && lapsing.expiresAt !== null}
						<span class="font-medium">
							{multi ? `The extra reset on “${lapsing.label}”` : 'It'} goes unused at {time(
								lapsing.expiresAt
							)} — redeem it in T3 Code before then if you need it.
						</span>
					{/if}
					{#if redeemHint}
						<!-- When to act: before it lapses, or once the limit runs dry before its reset. -->
						<span class="font-medium">
							{#if redeemHint.expiresAt !== null && redeemHint.expiresAt < redeemHint.at}
								{multi ? `The extra reset on “${redeemHint.label}”` : 'It'} expires before you run out
								(around {time(redeemHint.at)}) — use it in T3 Code by {time(redeemHint.expiresAt)}.
							{:else}
								{multi ? `“${redeemHint.label}” runs` : 'You run'} out around {time(redeemHint.at)},
								before the reset — redeem an extra reset in T3 Code once it hits 0%{redeemBy !==
								null
									? `, by ${time(redeemBy)}`
									: ''}.
							{/if}
						</span>
					{/if}
				</div>
			</div>
		{/if}

		{#if pool.recorded.length || pool.projected.length}
			<QuotaChart
				{pool}
				{color}
				from={range.from}
				expiries={credits.flatMap((c) => (c.expiresAt !== null ? [c.expiresAt] : []))}
				ariaLabel={summary}
			/>
			<div class="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				<span class="flex items-center gap-1.5">
					<span class="h-0.5 w-4 rounded-full" style:background-color={color}></span>
					Recorded
				</span>
				{#if pool.assumedUntil !== null}
					<span class="flex items-center gap-1.5">
						<span class="w-4 border-t-2 border-dotted opacity-60" style:border-color={color}></span>
						Assumed (no readings yet)
					</span>
				{/if}
				{#if pool.projected.length}
					<span class="flex items-center gap-1.5">
						<span class="w-4 border-t-2 border-dashed opacity-80" style:border-color={color}></span>
						Projected
					</span>
				{/if}
				{#if creditExpiry !== null && pool.projected.length && creditExpiry <= pool.projected.at(-1)!.at}
					<span class="flex items-center gap-1.5">
						<span class="size-2 rotate-45 border-[1.5px] border-foreground bg-card"></span>
						Extra reset expires
					</span>
				{/if}
				<span class="ml-auto">checked {formatTimeAgo(checkedAt, now)}</span>
			</div>
		{:else}
			<p class="py-8 text-center text-sm text-muted-foreground">No readings in this period.</p>
		{/if}

		{#if resets.length}
			<!-- Every scheduled reset coming up, soonest first, with what it gives back. -->
			<div class="flex flex-col gap-1 border-t pt-4">
				<h3 class="text-xs font-medium text-muted-foreground">Upcoming resets</h3>
				<ul class="grid gap-x-12 text-sm sm:grid-cols-2">
					{#each resets as r (r.key)}
						<li class="flex items-center justify-between gap-3 border-b border-border/60 py-2">
							<div class="flex min-w-0 flex-col">
								<span class="truncate">
									<span class="font-medium">{r.windowLabel}</span>
									{#if multi}<span class="text-muted-foreground"> · {r.accountLabel}</span>{/if}
								</span>
								<span class="text-xs text-muted-foreground tabular-nums"
									>{time(r.at)} · in {formatDuration(r.at - now)}</span
								>
							</div>
							<div class="flex shrink-0 flex-col items-end">
								<span class="font-medium tabular-nums">+{r.gain}%</span>
								<!-- What is left by then at the current pace: it and the gain make 100%. -->
								{#if r.gain >= 100}
									<span class="text-xs font-medium text-destructive">
										<TriangleAlertIcon
											class="mr-0.5 inline size-3 align-[-1px]"
											aria-hidden="true"
										/>empty before reset
									</span>
								{:else}
									<span class="text-xs text-muted-foreground tabular-nums"
										>{100 - r.gain}% left by then</span
									>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
