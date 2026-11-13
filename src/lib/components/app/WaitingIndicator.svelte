<script lang="ts">
	import { fade } from 'svelte/transition';
	import { cn } from '$lib/utils.js';
	import WaitingMark from './WaitingMark.svelte';

	/**
	 * The chat log's counterpart to the sidebar's "Waiting" row: the run ended,
	 * but the agent picks up again by itself once its background work reports
	 * back. The sidebar's flipping hourglass, inside a slowly breathing halo.
	 */
	let { class: className }: { class?: string } = $props();
</script>

<!-- Not a live region: ChatView announces the state instead. -->
<div
	class={cn('flex items-center gap-2.5 text-sm text-muted-foreground', className)}
	in:fade={{ duration: 200 }}
>
	<!-- Same 20px icon slot as the thinking indicator and activity rows. -->
	<span class="relative flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
		<span class="waiting-halo absolute inset-0 rounded-full bg-muted-foreground/15"></span>
		<WaitingMark class="relative size-3.5" />
	</span>
	<span class="text-shimmer font-medium">Waiting on background work</span>
	<span class="text-xs text-muted-foreground/80 max-sm:hidden">Resumes on its own</span>
</div>

<style>
	/* A slow breath, timed with the hourglass flip: calm, not busy. */
	.waiting-halo {
		animation: waiting-breathe 3s ease-in-out infinite;
	}

	@keyframes waiting-breathe {
		0%,
		100% {
			transform: scale(0.7);
			opacity: 0.4;
		}
		50% {
			transform: scale(1.25);
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.waiting-halo {
			animation: none;
		}
	}
</style>
