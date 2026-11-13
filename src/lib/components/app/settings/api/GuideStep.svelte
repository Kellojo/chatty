<script lang="ts">
	import type { Snippet } from 'svelte';

	/** One numbered step of a guide, with a line connecting it to the next. */
	let {
		n,
		title,
		last = false,
		children
	}: { n: number; title: string; last?: boolean; children: Snippet } = $props();
</script>

<li class="relative flex gap-3 {last ? '' : 'pb-6'}">
	{#if !last}
		<span class="absolute top-7 bottom-1 left-3 w-px bg-border" aria-hidden="true"></span>
	{/if}
	<span
		class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground tabular-nums"
		aria-hidden="true">{n}</span
	>
	<div class="flex min-w-0 flex-1 flex-col gap-3 pt-0.5">
		<h3 class="text-sm font-medium">{title}</h3>
		{@render children()}
	</div>
</li>
