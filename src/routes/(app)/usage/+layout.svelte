<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import {
		DEFAULT_USAGE_PERIOD,
		USAGE_PERIODS,
		isUsagePeriod,
		parseUsagePeriod,
		periodQuery
	} from '$lib/components/app/usage/usage.js';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	const path = $derived(page.url.pathname.replace(/\/$/, ''));
	const period = $derived(parseUsagePeriod(page.url.searchParams.get('period')));
	const onRequests = $derived(path.startsWith('/usage/requests'));
	const onSubscriptions = $derived(path.startsWith('/usage/subscriptions'));

	// Tab links carry the period so every tab shows the same window.
	const tabs = $derived([
		{ href: resolve('/usage'), label: 'Overview', active: path === '/usage' },
		{ href: resolve('/usage/requests'), label: 'Requests', active: onRequests },
		{ href: resolve('/usage/subscriptions'), label: 'Subscriptions', active: onSubscriptions }
	]);

	// One time control for the whole section. The Requests log additionally offers 24h, all time
	// and custom dates; those live in `range` and don't change the shared period.
	type TimeOption = { value: string; label: string; title: string };
	const PERIOD_OPTIONS: TimeOption[] = USAGE_PERIODS.map((p) => ({
		value: p,
		label: p,
		title: `Last ${Number.parseInt(p, 10)} days`
	}));
	const options = $derived<TimeOption[]>(
		onRequests
			? [
					{ value: '24h', label: '24h', title: 'Last 24 hours' },
					...PERIOD_OPTIONS,
					{ value: 'all', label: 'All', title: 'All time' },
					{ value: 'custom', label: 'Custom', title: 'Custom dates' }
				]
			: PERIOD_OPTIONS
	);
	const activeOption = $derived.by(() => {
		if (!onRequests) return period;
		const range = page.url.searchParams.get('range');
		if (range) return range;
		if (page.url.searchParams.has('from') || page.url.searchParams.has('to')) return 'custom';
		return period;
	});
	// Nothing to filter on an empty Subscriptions tab.
	const showTimeControl = $derived(
		!onSubscriptions ||
			(page.data as { subscriptions?: { environments: unknown[] } }).subscriptions?.environments
				.length !== 0
	);

	/** The current page showing `value` (on Requests, starting the log over at page 1). */
	function optionHref(value: string): string {
		// A throwaway copy for building one href, not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams(page.url.searchParams);
		for (const key of ['range', 'from', 'to', 'page']) params.delete(key);
		if (isUsagePeriod(value)) {
			if (value === DEFAULT_USAGE_PERIOD) params.delete('period');
			else params.set('period', value);
		} else params.set('range', value);
		const qs = params.toString();
		return qs ? `${page.url.pathname}?${qs}` : page.url.pathname;
	}
</script>

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-6">
		<div class="flex flex-col gap-3">
			<!-- Left padding on phones clears the floating "open sidebar" button. -->
			<h1 class="flex items-center gap-2 pl-10 text-xl font-semibold md:pl-0">
				<GaugeIcon class="size-5" />
				Usage
			</h1>
			<div class="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:border-b">
				<!-- Tabs sit on the line instead of overlapping it, so the scroller never overflows
				     vertically (which showed a stray scrollbar). -->
				<nav
					class="-mx-4 flex [scrollbar-width:none] gap-1 overflow-x-auto overflow-y-hidden border-b px-4 md:mx-0 md:border-b-0 md:px-0"
					aria-label="Usage"
				>
					{#each tabs as tab (tab.href)}
						<!-- eslint-disable svelte/no-navigation-without-resolve -- href comes from resolve() -->
						<a
							href={`${tab.href}${periodQuery(period)}`}
							aria-current={tab.active ? 'page' : undefined}
							class="shrink-0 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors md:py-2 {tab.active
								? 'border-foreground font-medium text-foreground'
								: 'border-transparent text-muted-foreground hover:text-foreground'}"
						>
							{tab.label}
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/each}
				</nav>
				{#if showTimeControl}
					<div
						class="flex max-w-full self-start overflow-x-auto rounded-lg border p-0.5 md:mb-1.5 md:self-auto"
						role="group"
						aria-label="Time range"
					>
						{#each options as option (option.value)}
							{@const active = option.value === activeOption}
							<!-- eslint-disable svelte/no-navigation-without-resolve -- the current page's own URL -->
							<a
								href={optionHref(option.value)}
								title={option.title}
								aria-label={option.title}
								aria-current={active ? 'true' : undefined}
								data-sveltekit-noscroll
								class="flex h-10 min-w-10 shrink-0 items-center justify-center rounded-md px-2.5 text-xs tabular-nums md:h-7 md:min-w-0 {active
									? 'bg-accent font-medium text-accent-foreground'
									: 'text-muted-foreground hover:text-foreground'}"
							>
								{option.label}
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/each}
					</div>
				{/if}
			</div>
		</div>

		{@render children()}
	</div>
</div>
