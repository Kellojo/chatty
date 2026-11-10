<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		name,
		image = null,
		class: className
	}: {
		name: string;
		image?: string | null;
		/** Sizing (e.g. `size-7 text-xs`); the avatar is round and decorative. */
		class?: string;
	} = $props();

	const initials = $derived(
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? '')
			.join('')
	);
</script>

{#if image}
	<img src={image} alt="" class={cn('size-7 shrink-0 rounded-full object-cover', className)} />
{:else}
	<span
		class={cn(
			'flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground',
			className
		)}
		aria-hidden="true"
	>
		{initials}
	</span>
{/if}
