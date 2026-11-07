<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		actions
	}: {
		title: string;
		description?: Snippet | string;
		/** Primary page actions, right of the title (wrap under it on phones). */
		actions?: Snippet;
	} = $props();
</script>

<header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
	<div class="flex min-w-0 flex-col gap-1">
		<!-- Phones show the section as the active tab, so the heading is only visible from sm up. -->
		<h2 class="sr-only text-lg font-semibold sm:not-sr-only">{title}</h2>
		{#if typeof description === 'string'}
			<p class="max-w-2xl text-sm text-pretty text-muted-foreground">{description}</p>
		{:else if description}
			<p class="max-w-2xl text-sm text-pretty text-muted-foreground">{@render description()}</p>
		{/if}
	</div>
	{#if actions}
		<div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>
	{/if}
</header>
