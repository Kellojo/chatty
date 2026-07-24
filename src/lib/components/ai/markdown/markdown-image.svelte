<script lang="ts">
	// CSP-safe replacement for streamdown's default image renderer.
	// The default emits inline onload/onerror attributes during SSR, which are
	// blocked by script-src (nonce mode), so we bind listeners via Svelte events.
	import { onMount } from 'svelte';
	import { cn } from '$lib/utils';

	type Props = {
		src?: string | null;
		alt?: string;
		class?: string;
	};

	let { src, alt = '', class: className }: Props = $props();

	let loaded = $state(false);
	let failed = $state(false);
	let imgEl = $state<HTMLImageElement | null>(null);

	onMount(() => {
		if (!imgEl) return;
		if (imgEl.complete) {
			if (imgEl.naturalWidth > 0) loaded = true;
			else failed = true;
		}
	});
</script>

{#if !src || failed}
	<span
		class="my-4 inline-block rounded bg-neutral-200 px-3 py-1 text-sm text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400"
	>
		Image not available: {alt || src}
	</span>
{:else}
	<img
		bind:this={imgEl}
		{src}
		{alt}
		class={cn('my-4 max-w-full rounded-lg', className)}
		class:opacity-0={!loaded}
		onload={() => (loaded = true)}
		onerror={() => (failed = true)}
	/>
{/if}
