<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	let {
		icon: Icon,
		title,
		description,
		compact = false,
		children
	}: {
		icon: Component<{ class?: string }>;
		title: string;
		description?: string;
		/** Less vertical padding, for an empty section above other content. */
		compact?: boolean;
		/** Call to action under the text. */
		children?: Snippet;
	} = $props();
</script>

<div class="flex flex-col items-center gap-3 px-6 text-center {compact ? 'py-4' : 'py-10'}">
	<div class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
		<Icon class="size-5" />
	</div>
	<div class="flex flex-col gap-1">
		<p class="text-sm font-medium">{title}</p>
		{#if description}
			<p class="max-w-sm text-sm text-pretty text-muted-foreground">{description}</p>
		{/if}
	</div>
	{#if children}
		<div class="flex flex-wrap justify-center gap-2">{@render children()}</div>
	{/if}
</div>
