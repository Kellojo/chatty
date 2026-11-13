<script lang="ts">
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import DailyStackedChart from '$lib/components/app/usage/DailyStackedChart.svelte';
	import { formatTimeAgo } from '$lib/datetime.js';
	import { formatDayLong } from '$lib/components/app/usage/usage.js';
	import { fadeWhenScrollable } from '$lib/fade-when-scrollable.js';
	import { formatLatency, formatWholeCountTick } from '$lib/formats.js';
	import type { McpServerUsageDetail } from '$lib/types.js';

	let {
		open = $bindable(false),
		serverName,
		detail,
		lastUsedAt = null,
		onDisable
	}: {
		open?: boolean;
		serverName: string;
		/** Null while loading. */
		detail: McpServerUsageDetail | null;
		/** Latest call ever, for a server idle in the window. */
		lastUsedAt?: number | null;
		/** Turns the server off (true once saved); offered when it went unused. Absent: already off. */
		onDisable?: () => Promise<boolean>;
	} = $props();

	let content = $state<HTMLElement | null>(null);
	let disabling = $state(false);

	async function disable() {
		if (!onDisable) return;
		disabling = true;
		try {
			if (await onDisable()) open = false;
		} finally {
			disabling = false;
		}
	}

	/** Share as a whole percent; any nonzero part shows as at least 1%. */
	const percent = (part: number, whole: number) =>
		whole === 0 || part === 0 ? '0%' : `${Math.max(1, Math.round((part / whole) * 100))}%`;
	const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

	const totals = $derived.by(() => {
		const tools = detail?.tools ?? [];
		const calls = tools.reduce((n, t) => n + t.calls, 0);
		const errors = tools.reduce((n, t) => n + t.errors, 0);
		const ms = tools.reduce((n, t) => n + t.avgMs * t.calls, 0);
		return { calls, errors, avgMs: calls ? Math.round(ms / calls) : 0 };
	});
	const topCalls = $derived(Math.max(1, ...(detail?.tools.map((t) => t.calls) ?? [])));
	// Bars compare tools; when every count is equal they'd all be full and say nothing.
	const showBars = $derived(
		(detail?.tools ?? []).some((t) => t.calls !== topCalls || t.errors > 0)
	);
	const busiest = $derived(
		(detail?.daily ?? []).reduce<{ day: string; calls: number } | null>(
			(best, d) => (d.calls > (best?.calls ?? 0) ? d : best),
			null
		)
	);
	const chartSummary = $derived(
		busiest
			? `${plural(totals.calls, 'call')} in the last ${detail?.days} days; busiest day ${formatDayLong(busiest.day)} with ${plural(busiest.calls, 'call')}.`
			: ''
	);
	const DAY_MS = 86_400_000;
	/** "45 days ago (Sep 29, 2026)": the gap is what matters when deciding to drop a server. */
	function lastUsedText(at: number): string {
		const days = Math.floor((Date.now() - at) / DAY_MS);
		const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(at);
		return days >= 2 ? `${days} days ago (${date})` : formatTimeAgo(at);
	}

	const series = [
		{ key: 'ok', label: 'Succeeded', color: 'var(--success)' },
		{ key: 'failed', label: 'Failed', color: 'var(--destructive)' }
	];
	const rows = $derived(
		(detail?.daily ?? []).map((d) => ({ day: d.day, ok: d.calls - d.errors, failed: d.errors }))
	);

	/** Dividers of the stat grid: 2x2 on phones, one row of 4 from `sm`. */
	const cellBorders = (i: number) =>
		[i % 2 && 'border-l', i >= 2 && 'max-sm:border-t', i === 2 && 'sm:border-l']
			.filter(Boolean)
			.join(' ');
	const bone = (size: string) =>
		`animate-pulse rounded bg-foreground/8 motion-reduce:animate-none ${size}`;
	/** Tool names wrap only after an underscore, never inside a word. */
	const nameParts = (name: string) => name.split(/(?<=_)/);

	const stats = $derived([
		{ label: 'Calls', value: totals.calls.toLocaleString(), tone: '' },
		{
			label: 'Failed',
			value: totals.errors ? percent(totals.errors, totals.calls) : 'None',
			tone: totals.errors ? 'text-destructive' : ''
		},
		{ label: 'Avg time', value: formatLatency(totals.avgMs), tone: '' },
		{ label: 'Users', value: (detail?.users ?? 0).toLocaleString(), tone: '' }
	]);
</script>

<Dialog.Root bind:open>
	<!-- Focus the dialog itself on open: the first tabbable is the footer's Close, whose
	     focus ring would otherwise greet every mouse open. -->
	<Dialog.Content
		bind:ref={content}
		tabindex={-1}
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			content?.focus();
		}}
		class="flex max-h-[92dvh] flex-col gap-5 sm:max-h-[85dvh] sm:max-w-xl"
	>
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="truncate pr-8 leading-normal font-semibold"
				>{serverName} usage</Dialog.Title
			>
			<Dialog.Description>
				Tool calls by all users in the last {detail?.days ?? 30} days.
			</Dialog.Description>
		</Dialog.Header>

		{#if !detail}
			<!-- The loaded layout's shape, so the dialog doesn't jump when data arrives. -->
			<div class="flex flex-col gap-6" role="status" aria-label="Loading usage">
				<div class="grid grid-cols-2 overflow-hidden rounded-xl border sm:grid-cols-4">
					{#each [0, 1, 2, 3] as i (i)}
						<div class="flex flex-col gap-2 px-4 py-3 {cellBorders(i)}">
							<div class={bone('h-3 w-12')}></div>
							<div class={bone('h-6 w-16')}></div>
						</div>
					{/each}
				</div>
				<div class="flex flex-col gap-2">
					<div class={bone('h-5 w-28')}></div>
					<div class={bone('h-28 rounded-xl sm:h-36')}></div>
					<div class={bone('mt-0.5 h-4 w-40 self-center')}></div>
				</div>
				<div class="flex flex-col gap-2">
					<div class={bone('h-5 w-24')}></div>
					<ul class="flex flex-col divide-y divide-border/60">
						{#each [0, 1, 2] as i (i)}
							<li class="flex flex-col gap-2 py-2.5">
								<div class={bone('h-4 w-2/5')}></div>
								<div class={bone('h-1 rounded-full')}></div>
								<div class={bone('h-3 w-1/2')}></div>
							</li>
						{/each}
					</ul>
				</div>
			</div>
		{:else if detail.tools.length === 0}
			<div class="flex flex-col items-center gap-3 px-6 py-6 text-center">
				<div
					class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
				>
					<ChartColumnIcon class="size-5" />
				</div>
				<div class="flex flex-col gap-1">
					<p class="text-sm font-medium">
						{lastUsedAt ? `Not used in the last ${detail.days} days` : 'Never used'}
					</p>
					<p class="text-sm text-balance text-muted-foreground">
						{lastUsedAt
							? `Last used ${lastUsedText(lastUsedAt)}.`
							: 'No model has called its tools yet.'}
					</p>
					{#if onDisable}
						<p class="text-sm text-balance text-muted-foreground">
							If nobody needs it, consider turning it off.
						</p>
					{/if}
				</div>
			</div>
		{:else}
			<!-- Only this part scrolls; it fades out at the bottom while more is below. -->
			<!-- Focusable so keyboards can scroll it in every browser. -->
			<div
				{@attach fadeWhenScrollable}
				role="region"
				aria-label="Usage details"
				tabindex="0"
				class="-mx-6 flex min-h-0 flex-col gap-6 overflow-y-auto px-6 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset data-more-below:[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]"
			>
				<dl class="grid shrink-0 grid-cols-2 overflow-hidden rounded-xl border sm:grid-cols-4">
					{#each stats as s, i (s.label)}
						<div class="flex flex-col gap-0.5 px-4 py-3 {cellBorders(i)}">
							<dt class="text-xs text-muted-foreground">{s.label}</dt>
							<dd class="text-xl font-semibold tabular-nums {s.tone}">{s.value}</dd>
						</div>
					{/each}
				</dl>

				<section class="flex shrink-0 flex-col gap-2" aria-labelledby="mcp-usage-daily">
					<h3 id="mcp-usage-daily" class="text-sm font-medium">Calls per day</h3>
					<DailyStackedChart
						{rows}
						{series}
						valueFormat={(v) => v.toLocaleString()}
						axisFormat={formatWholeCountTick}
						summary={chartSummary}
						class="max-h-28 min-h-28 sm:max-h-36 sm:min-h-36"
					/>
				</section>

				<section class="flex shrink-0 flex-col gap-2" aria-labelledby="mcp-usage-tools">
					<h3 id="mcp-usage-tools" class="text-sm font-medium">
						Tools called
						<span class="font-normal text-muted-foreground tabular-nums">
							· {detail.tools.length}
						</span>
					</h3>
					<ul class="flex flex-col divide-y divide-border/60">
						{#each detail.tools as t (t.name)}
							<li class="flex flex-col gap-1.5 py-2.5">
								<div class="flex items-baseline justify-between gap-3">
									<span class="min-w-0 font-mono text-[13px] wrap-break-word"
										>{#each nameParts(t.name) as part, p (p)}{part}<wbr />{/each}</span
									>
									<span class="shrink-0 text-sm font-medium tabular-nums">
										{plural(t.calls, 'call')}
									</span>
								</div>
								{#if showBars}
									<div class="h-1 overflow-hidden rounded-full bg-foreground/8" aria-hidden="true">
										<div
											class="flex h-full justify-end rounded-full bg-success"
											style:width="{(t.calls / topCalls) * 100}%"
										>
											{#if t.errors}
												<div
													class="h-full bg-destructive"
													style:width="{(t.errors / t.calls) * 100}%"
												></div>
											{/if}
										</div>
									</div>
								{/if}
								<p class="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
									<span>{formatLatency(t.avgMs)} avg</span>
									{#if t.errors}
										<span class="text-destructive">{percent(t.errors, t.calls)} failed</span>
									{/if}
									<span>{plural(t.users, 'user')}</span>
									<span>last used {formatTimeAgo(t.lastUsedAt)}</span>
								</p>
							</li>
						{/each}
					</ul>
				</section>
			</div>
		{/if}

		<Dialog.Footer class="shrink-0">
			<Button variant="outline" onclick={() => (open = false)}>Close</Button>
			{#if detail && detail.tools.length === 0 && onDisable}
				<Button onclick={disable} disabled={disabling}>
					{disabling ? 'Turning off…' : 'Turn off server'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
