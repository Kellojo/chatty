<script lang="ts">
	import { cn } from '$lib/utils.js';
	import LiveElapsed from './LiveElapsed.svelte';

	/** The app's `>_` mark with a "typing" cursor, a shimmering label, and a live timer when `since` is known. */
	let { since = null, class: className }: { since?: number | null; class?: string } = $props();
</script>

<!-- Not a live region: it mounts with its text, which screen readers often skip. ChatView announces instead. -->
<div class={cn('flex items-center gap-2.5 text-sm text-muted-foreground', className)}>
	<!-- Same 20px icon slot as the activity rows, so the transition into them doesn't jump. -->
	<span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
		<svg
			class="size-3.5"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2.25"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<polyline points="4 17 10 11 4 5" />
			<line class="thinking-cursor" x1="12" x2="20" y1="19" y2="19" />
		</svg>
	</span>
	<span class="text-shimmer font-medium">Thinking</span>
	{#if since !== null}
		<LiveElapsed {since} class="text-xs" />
	{/if}
</div>

<style>
	/*
	 * The underscore grows and shrinks like a cursor typing, at twice the shimmer's rate.
	 * The dash reveals 4–8 of its 8 units, so the mark always reads as `>_`.
	 */
	.thinking-cursor {
		stroke-dasharray: 8 16;
		animation: thinking-type 1.2s ease-in-out infinite;
	}

	@keyframes thinking-type {
		0%,
		100% {
			stroke-dashoffset: 4;
		}
		50% {
			stroke-dashoffset: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.thinking-cursor {
			animation: none;
		}
	}
</style>
