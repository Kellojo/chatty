<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import { cn } from '$lib/utils.js';

	let {
		review = false,
		class: className
	}: {
		/** Chatty suggests reviewing it: it no longer finds personal details. */
		review?: boolean;
		class?: string;
	} = $props();

	const label = $derived(review ? 'Private, review suggested' : 'Private');
</script>

<!-- Marks a private memory: only models trusted with private data can see it. -->
<span
	class={cn('relative inline-flex shrink-0 text-muted-foreground', className)}
	role="img"
	title={label}
	aria-label={label}
>
	<LockIcon class="size-3" aria-hidden="true" />
	{#if review}
		<span
			class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber-500 ring-1 ring-background"
			aria-hidden="true"
		></span>
	{/if}
</span>
