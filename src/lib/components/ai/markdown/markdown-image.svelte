<script lang="ts">
	// CSP-safe replacement for streamdown's default image renderer.
	// The default emits inline onload/onerror attributes during SSR, which are
	// blocked by script-src (nonce mode), so we bind listeners via Svelte events.
	import { getContext, onMount } from 'svelte';
	import { cn } from '$lib/utils';
	import { codingAssetUrl, isLocalImagePath } from '$lib/coding-assets.js';

	type Props = {
		src?: string | null;
		alt?: string;
		class?: string;
	};

	let { src, alt = '', class: className }: Props = $props();

	// Coding agents embed screenshots by their path on the coding machine; those
	// load through Chatty's relay to the T3 server instead of the (unreachable) path.
	const conversationId = getContext<string | null | undefined>('conversationId');
	const local = $derived(!!src && isLocalImagePath(src));
	const resolvedSrc = $derived(
		local && src && conversationId ? codingAssetUrl(conversationId, src) : src
	);
	const fileName = $derived(src?.split(/[\\/]/).pop() ?? '');

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

{#if !resolvedSrc || failed}
	<span
		class="my-4 inline-block rounded bg-neutral-200 px-3 py-1 text-sm text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400"
		title={src ?? undefined}
	>
		Image not available: {alt || (local ? fileName : src)}
	</span>
{:else}
	<img
		bind:this={imgEl}
		src={resolvedSrc}
		{alt}
		class={cn('my-4 max-w-full rounded-lg', className)}
		class:opacity-0={!loaded}
		onload={() => (loaded = true)}
		onerror={() => (failed = true)}
	/>
{/if}
