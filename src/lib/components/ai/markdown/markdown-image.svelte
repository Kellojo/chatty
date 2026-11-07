<script lang="ts">
	// CSP-safe replacement for streamdown's default image renderer.
	// The default emits inline onload/onerror attributes during SSR, which are
	// blocked by script-src (nonce mode), so we bind listeners via Svelte events.
	// Local screenshot paths arrive already rewritten to the coding relay URL
	// (see `urlTransform` in markdown.svelte).
	import { onMount } from 'svelte';
	import { cn } from '$lib/utils';
	import * as Dialog from '$lib/components/ui/dialog/index.js';

	type Props = {
		src?: string | null;
		alt?: string;
		class?: string;
	};

	let { src, alt = '', class: className }: Props = $props();

	// For relayed images, name the file rather than the relay URL.
	const fileName = $derived.by(() => {
		if (!src?.startsWith('/api/coding/')) return src ?? '';
		const path = new URL(src, 'http://local').searchParams.get('path');
		return path?.split(/[\\/]/).pop() ?? src;
	});

	let loaded = $state(false);
	let failed = $state(false);
	let open = $state(false);
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
		title={src ?? undefined}
	>
		Image not available: {alt || fileName}
	</span>
{:else}
	<!-- Capped in height so screenshots don't take over the chat; click to view full size. -->
	<button
		type="button"
		class="cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		aria-label={`View ${alt || fileName || 'image'} full size`}
		onclick={() => (open = true)}
	>
		<img
			bind:this={imgEl}
			{src}
			{alt}
			class={cn('my-4 max-h-96 w-auto max-w-full rounded-lg', className)}
			class:opacity-0={!loaded}
			onload={() => (loaded = true)}
			onerror={() => (failed = true)}
		/>
	</button>
	<Dialog.Root bind:open>
		<Dialog.Content
			class="w-auto max-w-[calc(100vw-2rem)] bg-transparent p-0 shadow-none ring-0 sm:max-w-[calc(100vw-4rem)] dark:ring-0"
		>
			<Dialog.Title class="sr-only">{alt || fileName || 'Image'}</Dialog.Title>
			<img {src} {alt} class="max-h-[calc(100dvh-4rem)] max-w-full rounded-lg object-contain" />
		</Dialog.Content>
	</Dialog.Root>
{/if}
