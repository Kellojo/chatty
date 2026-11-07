<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';
	import { isExpiredWindow, remainingPercent, resetLabel } from './usage.js';

	let {
		window: w,
		label,
		ariaLabel,
		now
	}: {
		window: CodingUsageLimitWindow;
		/** Text left of the percentage; defaults to the window's own label. */
		label?: string;
		ariaLabel: string;
		now: number;
	} = $props();

	// The bar shows what is LEFT: it starts full and empties to 0% as the plan is used up.
	const left = $derived(remainingPercent(w));
	const reset = $derived(resetLabel(w.resetsAt, now));
	// Past its reset time the stored percentage is stale: show it muted, without warnings.
	const expired = $derived(isExpiredWindow(w, now));
	// Warn at 20% left, critical at 5% left; always with text and icon, never color alone.
	const level = $derived(
		expired ? 'stale' : left <= 5 ? 'critical' : left <= 20 ? 'warning' : 'ok'
	);
	const tone = $derived(
		level === 'critical'
			? 'text-destructive'
			: level === 'warning'
				? 'text-amber-600 dark:text-amber-400'
				: ''
	);
</script>

<div class="flex flex-col gap-1.5">
	<div class="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
		<span class="min-w-0 truncate font-medium">{label ?? w.windowLabel}</span>
		<span class="shrink-0 text-muted-foreground tabular-nums">
			{#if level === 'critical' || level === 'warning'}
				<TriangleAlertIcon class="mr-1 inline size-3.5 {tone}" aria-hidden="true" />
				<span class={tone}>{level === 'critical' ? 'Almost out' : 'Running low'} ·</span>
			{/if}
			{#if expired}
				<span class="line-through decoration-muted-foreground/60">{left}% left</span> ·
				{reset}
			{:else}
				<span class="font-medium text-foreground {tone}">{left}% left</span>{reset
					? ` · ${reset}`
					: ''}
			{/if}
		</span>
	</div>
	<div
		class="h-2.5 overflow-hidden rounded-full bg-muted"
		role="progressbar"
		aria-label="{ariaLabel}: remaining"
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={left}
		aria-valuetext="{left}% left"
	>
		<div
			class="h-full rounded-full transition-[width] {level === 'critical'
				? 'bg-destructive'
				: level === 'warning'
					? 'bg-amber-500'
					: level === 'stale'
						? 'bg-muted-foreground/30'
						: 'bg-foreground/80'}"
			style:width="{Math.min(100, Math.max(left, left > 0 ? 2 : 0))}%"
		></div>
	</div>
</div>
