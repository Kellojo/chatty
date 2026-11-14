<script lang="ts">
	// An image attachment in the chat: rotatable in place, click opens the viewer.
	// CSS rotation doesn't change layout, so the frame is sized to the rotated
	// footprint (see `fitRotated`) and the image is centered and turned inside it.
	import { fitRotated } from '$lib/image-fit.js';
	import { cn } from '$lib/utils.js';
	import ImageViewer from './ImageViewer.svelte';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import DownloadIcon from '@lucide/svelte/icons/download';

	let {
		src,
		alt = 'Attachment',
		filename,
		align = 'start'
	}: {
		src: string;
		alt?: string;
		filename?: string;
		align?: 'start' | 'end';
	} = $props();

	const MAX_W = 448;
	const MAX_H = 384;

	let imgEl = $state<HTMLImageElement | null>(null);
	let availW = $state(0);
	let natural = $state<{ w: number; h: number } | null>(null);
	let failed = $state(false);
	/** Unnormalized degrees, shared with the viewer so both stay turned the same way. */
	let rotation = $state(0);
	let viewerOpen = $state(false);

	const fit = $derived(
		natural && availW
			? fitRotated(natural.w, natural.h, Math.min(availW, MAX_W), MAX_H, rotation)
			: null
	);

	// A cached image can finish loading before hydration attaches onload.
	$effect(() => {
		if (imgEl?.complete && !natural) {
			if (imgEl.naturalWidth > 0) readNatural(imgEl);
			else failed = true;
		}
	});

	function readNatural(img: HTMLImageElement) {
		if (img.naturalWidth > 0) natural = { w: img.naturalWidth, h: img.naturalHeight };
	}

	/** Natural size to fitted size; see ImageViewer for why the scale lives in the transform. */
	const fitScale = $derived(fit && natural ? fit.width / natural.w : 1);

	// Dark glass reads the same over light and dark images, in either theme.
	const toolBtn =
		'flex size-8 items-center [@media(hover:none)]:size-10 justify-center rounded-md border border-white/15 bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none';
</script>

<div
	bind:clientWidth={availW}
	class={cn('flex w-full', align === 'end' ? 'justify-end' : 'justify-start')}
>
	{#if failed}
		<span class="rounded-md bg-muted px-3 py-1 text-sm text-muted-foreground">
			Image not available{filename ? `: ${filename}` : ''}
		</span>
	{:else}
		<div
			class={cn(
				'group relative max-w-full overflow-hidden rounded-md ring-1 ring-border transition-[width,height] duration-200 ease-out motion-reduce:transition-none',
				// Until the image arrives, hold a little space so it doesn't pop in from nothing.
				!fit && 'min-h-24 min-w-40 animate-pulse bg-muted motion-reduce:animate-none'
			)}
			style:width={fit ? `${fit.boxWidth}px` : undefined}
			style:height={fit ? `${fit.boxHeight}px` : undefined}
		>
			<button
				type="button"
				class="block size-full cursor-zoom-in focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label={`View ${filename || 'image'} full size`}
				onclick={() => (viewerOpen = true)}
			>
				<img
					bind:this={imgEl}
					{src}
					{alt}
					draggable="false"
					onload={(e) => readNatural(e.currentTarget as HTMLImageElement)}
					onerror={() => (failed = true)}
					class={fit
						? 'absolute top-1/2 left-1/2 max-w-none transition-transform duration-200 ease-out motion-reduce:transition-none'
						: 'block max-h-96 w-auto max-w-full opacity-0'}
					style:width={fit && natural ? `${natural.w}px` : undefined}
					style:height={fit && natural ? `${natural.h}px` : undefined}
					style:transform={fit
						? `translate(-50%, -50%) scale(${fitScale}) rotate(${rotation}deg)`
						: undefined}
				/>
			</button>
			{#if fit}
				<div
					class="absolute right-2 bottom-2 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
				>
					<button
						type="button"
						title="Rotate left"
						aria-label="Rotate left"
						onclick={() => (rotation -= 90)}
						class={toolBtn}
					>
						<RotateCcwIcon class="size-4" />
					</button>
					<button
						type="button"
						title="Rotate right"
						aria-label="Rotate right"
						onclick={() => (rotation += 90)}
						class={toolBtn}
					>
						<RotateCwIcon class="size-4" />
					</button>
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						href={src}
						download={filename ?? ''}
						title="Download image"
						aria-label="Download image"
						class={toolBtn}
					>
						<DownloadIcon class="size-4" />
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				</div>
			{/if}
		</div>
	{/if}
</div>

<ImageViewer bind:open={viewerOpen} bind:rotation {src} {alt} {filename} />
