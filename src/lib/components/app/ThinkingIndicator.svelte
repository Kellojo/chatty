<script lang="ts">
	import { cn } from '$lib/utils.js';
	import LiveElapsed from './LiveElapsed.svelte';

	/** "Thinking…" with bouncing dots, and a live timer when `since` is known. */
	let { since = null, class: className }: { since?: number | null; class?: string } = $props();
</script>

<div class={cn('flex items-center gap-2 text-muted-foreground', className)}>
	<span class="thinking-dots" aria-hidden="true">
		<span class="thinking-dot"></span>
		<span class="thinking-dot"></span>
		<span class="thinking-dot"></span>
	</span>
	<span class="text-sm">
		Thinking…
		{#if since !== null}<LiveElapsed {since} class="ml-0.5" />{/if}
	</span>
</div>

<style>
	.thinking-dots {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	.thinking-dot {
		width: 5px;
		height: 5px;
		border-radius: 9999px;
		background-color: currentColor;
		animation: thinking-bounce 1.2s ease-in-out infinite;
	}

	.thinking-dot:nth-child(2) {
		animation-delay: 0.15s;
	}

	.thinking-dot:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes thinking-bounce {
		0%,
		100% {
			transform: translateY(0);
			opacity: 0.4;
		}
		50% {
			transform: translateY(-3px);
			opacity: 1;
		}
	}
</style>
