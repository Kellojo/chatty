<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		children,
		footer
	}: { title: string; description?: string; children: Snippet; footer?: Snippet } = $props();
</script>

<div class="flex w-full flex-col gap-6">
	<div
		class="flex w-full flex-col gap-6 text-card-foreground sm:rounded-4xl sm:border sm:bg-card sm:px-8 sm:py-8 sm:shadow-sm"
	>
		<header class="flex flex-col gap-1.5 text-center">
			<h1 class="text-xl font-semibold tracking-tight">{title}</h1>
			{#if description}
				<p class="text-sm text-balance text-muted-foreground">{description}</p>
			{/if}
		</header>
		{@render children()}
	</div>
	{#if footer}
		<p class="text-center text-sm text-muted-foreground">
			{@render footer()}
		</p>
	{/if}
</div>
