<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { CodingUsageLimitWindow } from '$lib/coding-environments.js';
	import { resetLabel } from './usage.js';

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

	const pct = $derived(Math.round(w.usedPercent));
	const reset = $derived(resetLabel(w.resetsAt, now));
</script>

<div class="flex flex-col gap-1.5">
	<div class="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
		<span class="min-w-0 truncate font-medium">{label ?? w.windowLabel}</span>
		<span class="text-muted-foreground tabular-nums">
			{#if pct >= 90}
				<TriangleAlertIcon class="mr-1 inline size-3.5 text-destructive" aria-hidden="true" />
				<span class="text-destructive">Near limit ·</span>
			{/if}
			{pct}% used{reset ? ` · ${reset}` : ''}
		</span>
	</div>
	<div
		class="h-2 overflow-hidden rounded-full bg-muted"
		role="progressbar"
		aria-label={ariaLabel}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={pct}
	>
		<div
			class="h-full rounded-full transition-[width] {pct >= 90
				? 'bg-destructive'
				: 'bg-foreground/70'}"
			style:width="{Math.min(100, Math.max(pct, pct > 0 ? 2 : 0))}%"
		></div>
	</div>
</div>
