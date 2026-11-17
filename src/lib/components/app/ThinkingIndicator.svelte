<script lang="ts">
	import { untrack } from 'svelte';
	import { cn } from '$lib/utils.js';
	import LiveElapsed from './LiveElapsed.svelte';

	/** The app's `>_` mark with a blinking cursor, a shimmering label, and a live timer when `since` is known. */
	let { since = null, class: className }: { since?: number | null; class?: string } = $props();

	// Type in only when the wait just began, not when remounting into one already under way
	// (e.g. switching back to a chat that's been thinking for minutes).
	const fresh = untrack(() => since === null || Date.now() - since < 1000);
</script>

<!-- Not a live region: it mounts with its text, which screen readers often skip. ChatView announces instead. -->
<!-- Same tone, icon slot and timer as the live "Thinking" activity row, so the handoff doesn't jump. -->
<div
	class={cn('thinking flex items-center gap-2.5 text-sm text-foreground/80', className)}
	class:thinking-settled={!fresh}
>
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
	<!-- The label types itself in behind the cursor, then the timer joins it. -->
	<span class="thinking-typed"><span class="text-shimmer font-medium">Thinking</span></span>
	{#if since !== null}
		<LiveElapsed {since} class="thinking-after text-xs text-muted-foreground" />
	{/if}
</div>

<style>
	/*
	 * On mount, "Thinking" types itself in behind a solid cursor (~40ms a letter), then the
	 * timer joins, the shimmer starts and the cursor begins to blink, all on the same beat.
	 * The blink is caret-like: on longer than off, so the mark keeps reading as `>_`, with
	 * ~50ms fades that soften the snap without turning it into a pulse, twice per sweep.
	 * With reduced motion nothing types or sweeps and the cursor eases gently instead of
	 * flashing; in high-contrast modes it stays solid.
	 */
	.thinking {
		--thinking-typed: 320ms;
	}

	.thinking-settled {
		--thinking-typed: 0ms;
	}

	.thinking-settled .thinking-typed,
	.thinking-settled :global(.thinking-after) {
		animation: none;
	}

	.thinking-cursor {
		animation: thinking-blink 1.2s linear var(--thinking-typed) infinite;
	}

	@keyframes thinking-blink {
		/* Fades centre on 60% and 98%: on for ~62% of the cycle. */
		0%,
		58% {
			opacity: 1;
		}
		62%,
		96% {
			opacity: 0;
		}
	}

	/*
	 * Revealed a letter's width at a time; the inset overhangs vertically so descenders never
	 * clip, and the clip goes away once typed (backwards fill) rather than lingering.
	 */
	.thinking-typed {
		animation: thinking-type var(--thinking-typed) steps(8, end) backwards;
	}

	.thinking-typed > :global(.text-shimmer) {
		animation-delay: var(--thinking-typed);
	}

	@keyframes thinking-type {
		from {
			clip-path: inset(-0.25em 100% -0.25em 0);
		}
		to {
			clip-path: inset(-0.25em 0 -0.25em 0);
		}
	}

	.thinking :global(.thinking-after) {
		animation: thinking-after 200ms ease-out var(--thinking-typed) both;
	}

	@keyframes thinking-after {
		from {
			opacity: 0;
		}
	}

	@keyframes thinking-ease {
		50% {
			opacity: 0.5;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.thinking-cursor {
			animation: thinking-ease 2.4s ease-in-out infinite;
		}

		.thinking-typed,
		.thinking :global(.thinking-after) {
			animation: none;
		}
	}

	@media (forced-colors: active) {
		.thinking-cursor {
			animation: none;
		}
	}
</style>
