<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import { resolve } from '$app/paths';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import {
		DEFAULT_USAGE_PERIOD,
		isUsagePeriod,
		rangeQuery,
		selectedRange,
		type UsageRange
	} from '$lib/components/app/usage/usage.js';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	const path = $derived(page.url.pathname.replace(/\/$/, ''));
	const onRequests = $derived(path.startsWith('/usage/requests'));
	const onSubscriptions = $derived(path.startsWith('/usage/subscriptions'));
	const onSpeed = $derived(path.startsWith('/usage/speed'));
	// A single request has no time range to pick.
	const onRequestDetail = $derived(/^\/usage\/requests\/[^/]+$/.test(path));

	// Tab links carry the time range so every tab shows the same window.
	const tabs = $derived([
		{ href: resolve('/usage'), label: 'Overview', active: path === '/usage' },
		{ href: resolve('/usage/requests'), label: 'Requests', active: onRequests },
		{ href: resolve('/usage/subscriptions'), label: 'Subscriptions', active: onSubscriptions },
		{ href: resolve('/usage/speed'), label: 'Speed', active: onSpeed }
	]);
	const tabQuery = $derived(rangeQuery(page.url.searchParams));

	// One time control with the same options on every tab.
	const OPTIONS: { value: UsageRange; label: string; title: string }[] = [
		{ value: '24h', label: '24h', title: 'Last 24 hours' },
		{ value: '7d', label: '7d', title: 'Last 7 days' },
		{ value: '30d', label: '30d', title: 'Last 30 days' },
		{ value: '90d', label: '90d', title: 'Last 90 days' },
		{ value: 'all', label: 'All', title: 'All time' },
		{ value: 'custom', label: 'Custom', title: 'Custom dates' }
	];
	const activeOption = $derived(selectedRange(page.url.searchParams));
	// Nothing to filter on an empty Subscriptions tab or a single request.
	const showTimeControl = $derived(
		!onRequestDetail &&
			(!onSubscriptions ||
				(page.data as { subscriptions?: { environments: unknown[] } }).subscriptions?.environments
					.length !== 0)
	);

	/** The current page with `updates` applied to its range params (paging starts over). */
	function rangeHref(updates: Record<string, string>): string {
		// A throwaway copy for building one href, not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams(page.url.searchParams);
		params.delete('page');
		for (const [key, value] of Object.entries(updates)) {
			if (value) params.set(key, value);
			else params.delete(key);
		}
		const qs = params.toString();
		return qs ? `${page.url.pathname}?${qs}` : page.url.pathname;
	}

	function optionHref(value: UsageRange): string {
		if (isUsagePeriod(value))
			return rangeHref({
				period: value === DEFAULT_USAGE_PERIOD ? '' : value,
				range: '',
				from: '',
				to: ''
			});
		return rangeHref({ range: value, from: '', to: '' });
	}

	let customFrom = $state('');
	let customTo = $state('');
	$effect.pre(() => {
		customFrom = page.url.searchParams.get('from') ?? '';
		customTo = page.url.searchParams.get('to') ?? '';
	});

	function selectOption(value: UsageRange) {
		// Built from the current page's own URL.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(optionHref(value), { keepFocus: true, noScroll: true });
	}

	function applyCustom() {
		// Built from the current page's own URL.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(rangeHref({ range: 'custom', from: customFrom, to: customTo }), {
			keepFocus: true,
			noScroll: true
		});
	}
</script>

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
		<PageHeader
			title="Usage"
			icon={GaugeIcon}
			description="Tokens, cost, requests and model speed across your chats, agents and API keys."
		/>
		<!-- Tabs, with the time control right of them on one baseline; phones get a select
		     under the tabs instead. -->
		<div class="-mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-y-3">
			<!-- Tabs sit on the line instead of overlapping it, so the scroller never overflows
				     vertically (which showed a stray scrollbar). -->
			<nav
				class="col-span-2 row-start-1 -mx-4 flex [scrollbar-width:none] gap-1 self-end overflow-x-auto overflow-y-hidden border-b px-4 sm:mx-0 sm:px-0 {showTimeControl
					? 'sm:col-span-1'
					: ''}"
				aria-label="Usage"
			>
				{#each tabs as tab (tab.href)}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- href comes from resolve() -->
					<a
						href={`${tab.href}${tabQuery}`}
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
				<!-- Phones: a compact select on its own row under the tabs. -->
				<div class="col-span-2 row-start-2 sm:hidden">
					<Select.Root
						type="single"
						value={activeOption}
						onValueChange={(v) => {
							if (v) selectOption(v as UsageRange);
						}}
					>
						<Select.Trigger aria-label="Time range" class="w-full">
							{OPTIONS.find((o) => o.value === activeOption)?.title}
						</Select.Trigger>
						<Select.Content>
							{#each OPTIONS as option (option.value)}
								<Select.Item value={option.value}>{option.title}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
				<!-- From sm up: the segmented control. -->
				<div
					class="col-start-2 row-start-1 hidden min-w-0 items-end justify-end self-stretch border-b pb-1.5 pl-3 sm:flex"
				>
					<div
						class="flex max-w-full overflow-x-auto rounded-lg border p-0.5"
						role="group"
						aria-label="Time range"
					>
						{#each OPTIONS as option (option.value)}
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
				</div>
			{/if}
		</div>

		{#if showTimeControl && activeOption === 'custom'}
			<!-- Labelled, because an empty date input shows nothing on iOS (no placeholder).
			     min-w-0 + appearance-none: iOS gives date inputs a wide intrinsic size that
			     otherwise pushes them past the screen edge. -->
			<div class="-mt-3 grid grid-cols-2 gap-2 sm:flex sm:items-end sm:justify-end">
				<label class="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
					From
					<Input
						type="date"
						class="w-full min-w-0 appearance-none sm:w-[160px]"
						bind:value={customFrom}
						max={customTo || undefined}
						onchange={applyCustom}
					/>
				</label>
				<label class="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
					To
					<Input
						type="date"
						class="w-full min-w-0 appearance-none sm:w-[160px]"
						bind:value={customTo}
						min={customFrom || undefined}
						onchange={applyCustom}
					/>
				</label>
			</div>
		{/if}

		{@render children()}
	</div>
</div>
