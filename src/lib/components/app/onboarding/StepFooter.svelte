<script lang="ts">
	import type { Snippet } from 'svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button/index.js';

	let {
		onback,
		onnext,
		nextLabel = 'Continue',
		nextDisabled = false,
		busy = false,
		center = false,
		secondary
	}: {
		onback?: () => void;
		/** The primary action; leave out when the step has its own (e.g. "Connect"). */
		onnext?: () => void;
		nextLabel?: string;
		nextDisabled?: boolean;
		busy?: boolean;
		/** Centre the actions (the welcome screen, which has no Back). */
		center?: boolean;
		/** e.g. "Skip tour", shown before the primary button. */
		secondary?: Snippet;
	} = $props();
</script>

<!-- Keeps the content clear of the bar once scrolled to the end. -->
<div class="min-h-10 flex-1" aria-hidden="true"></div>
<!-- Sticks to the bottom of the viewport, so the way forward never scrolls out of reach. -->
<div
	class={[
		'sticky bottom-0 z-10 -mx-4 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6',
		// The centred welcome CTA stands alone; a bar behind it would read as a stray rule.
		!center && 'border-t border-border/60 bg-background/85 backdrop-blur-md'
	]}
>
	<div
		class={['flex flex-wrap items-center gap-2', center ? 'flex-col-reverse justify-center' : '']}
	>
		{#if onback}
			<Button variant="ghost" class="text-muted-foreground" onclick={onback}>
				<ArrowLeftIcon />Back
			</Button>
		{/if}
		<div class={['flex items-center gap-3', center ? 'flex-col' : 'ml-auto']}>
			{@render secondary?.()}
			{#if onnext}
				<Button
					size="lg"
					class="group min-w-32 shadow-lg shadow-foreground/15 dark:shadow-foreground/10"
					data-primary
					disabled={nextDisabled || busy}
					aria-busy={busy}
					onclick={onnext}
				>
					{#if busy}<LoaderCircleIcon class="animate-spin" />{/if}
					{nextLabel}
					{#if !busy}
						<ArrowRightIcon
							class="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
						/>
					{/if}
				</Button>
			{/if}
		</div>
	</div>
</div>
