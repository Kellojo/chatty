<script lang="ts">
	import type { Snippet } from 'svelte';
	import { version } from '$lib/version.js';

	let { children }: { children: Snippet } = $props();
</script>

<main class="flex min-h-dvh flex-col items-center justify-center bg-background p-6">
	<div class="flex w-full max-w-sm flex-col items-center gap-6">
		<div class="flex items-center gap-2.5">
			<svg
				viewBox="0 0 24 24"
				class="size-6 shrink-0 rounded-lg bg-foreground text-background"
				aria-hidden="true"
			>
				<g
					transform="translate(3.5 3.5) scale(0.7083)"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M5.5 6.5l5 5.5-5 5.5" />
					<path class="brand-cursor" d="M12.5 18h6" />
				</g>
			</svg>
			<a
				href="https://github.com/Kellojo/ai-chat"
				target="_blank"
				rel="noopener noreferrer"
				class="text-base font-semibold tracking-tight hover:underline"
				title="GitHub repository"
			>
				Chatty
			</a>
			<span class="text-xs text-muted-foreground">v{version}</span>
		</div>
		{@render children()}
	</div>
</main>

<style>
	.brand-cursor {
		animation: brand-blink 1.06s steps(1) infinite;
	}
	@keyframes brand-blink {
		0%,
		53% {
			opacity: 1;
		}
		54%,
		100% {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.brand-cursor {
			animation: none;
		}
	}
</style>
