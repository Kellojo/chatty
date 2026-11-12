<script lang="ts">
	import type { Snippet } from 'svelte';
	import { version } from '$lib/version.js';

	let { children }: { children: Snippet } = $props();
</script>

<main
	class="auth-bg flex min-h-dvh flex-col items-center justify-center bg-background px-4 pt-[calc(2.5rem+env(safe-area-inset-top))] pb-[calc(2.5rem+env(safe-area-inset-bottom))] sm:px-6"
>
	<div class="flex w-full max-w-sm flex-col items-center gap-8">
		<a
			href="https://github.com/Kellojo/ai-chat"
			target="_blank"
			rel="noopener noreferrer"
			class="group flex flex-col items-center gap-3 rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
			title="Chatty on GitHub"
		>
			<svg
				viewBox="0 0 24 24"
				class="size-11 shrink-0 rounded-2xl bg-foreground text-background shadow-sm transition-transform group-hover:scale-105"
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
			<span class="flex items-baseline gap-1.5">
				<span class="text-lg font-semibold tracking-tight">Chatty</span>
				<span class="text-xs text-muted-foreground">v{version}</span>
			</span>
		</a>
		{@render children()}
	</div>
</main>

<style>
	.auth-bg {
		background-image: radial-gradient(
			ellipse 60% 40% at 50% 0%,
			color-mix(in oklch, var(--foreground) 6%, transparent),
			transparent
		);
	}
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
