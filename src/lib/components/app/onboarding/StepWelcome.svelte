<script lang="ts">
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import StepFooter from './StepFooter.svelte';

	let {
		firstName,
		isAdmin,
		hasModel,
		stepCount,
		onnext
	}: {
		firstName: string;
		isAdmin: boolean;
		hasModel: boolean;
		stepCount: number;
		onnext: () => void;
	} = $props();

	const promises = [
		{
			icon: ShieldCheckIcon,
			title: 'Private by design',
			text: 'Runs on your own server. Your chats stay yours.'
		},
		{
			icon: ShuffleIcon,
			title: 'Any model',
			text: 'Claude, GPT, open models or your own, side by side.'
		},
		{
			icon: BrainIcon,
			title: 'Remembers what matters',
			text: 'Learns your preferences so you don’t repeat yourself.'
		}
	];
</script>

<div class="my-auto flex flex-col items-center text-center">
	<div class="welcome-mark relative mb-6 sm:mb-10" aria-hidden="true">
		<svg
			viewBox="0 0 24 24"
			class="relative size-16 rounded-[1.25rem] bg-foreground text-background shadow-xl sm:size-24 sm:rounded-[1.5rem]"
		>
			<g
				transform="translate(3.5 3.5) scale(0.7083)"
				fill="none"
				stroke="currentColor"
				stroke-width="2.4"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path class="chevron" pathLength="1" d="M5.5 6.5l5 5.5-5 5.5" />
				<path class="cursor" d="M12.5 18h6" />
			</g>
		</svg>
	</div>

	<p class="rise text-sm font-medium text-muted-foreground" style="--d: 0.15s">Welcome to Chatty</p>
	<h1
		data-step-heading
		tabindex="-1"
		class="rise mt-2 text-3xl font-semibold tracking-tight text-balance outline-none sm:text-5xl"
		style="--d: 0.25s"
	>
		Hi {firstName}, let’s set up<br class="hidden sm:block" /> your AI workspace
	</h1>
	<p
		class="rise mt-4 max-w-lg text-base text-pretty text-muted-foreground sm:text-lg"
		style="--d: 0.35s"
	>
		Chat with any model, hand longer jobs to agents, and build a memory that makes every answer more
		yours.
	</p>

	<ul class="mt-8 grid w-full gap-4 text-left sm:mt-10 sm:grid-cols-3 sm:gap-3">
		{#each promises as promise, i (promise.title)}
			<li
				class="rise flex gap-3 sm:flex-col sm:rounded-2xl sm:border sm:border-border/70 sm:bg-card/70 sm:p-4 sm:shadow-xs sm:backdrop-blur-sm"
				style="--d: {0.45 + i * 0.08}s"
			>
				<span
					class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground"
				>
					<promise.icon class="size-[1.125rem]" aria-hidden="true" />
				</span>
				<span class="flex flex-col gap-0.5">
					<span class="text-sm font-medium">{promise.title}</span>
					<span class="text-sm text-muted-foreground">{promise.text}</span>
				</span>
			</li>
		{/each}
	</ul>

	{#if !hasModel && !isAdmin}
		<p
			class="rise mt-6 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-left text-sm text-warning-foreground"
			style="--d: 0.7s"
		>
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			Chats need a model, and none is connected yet. Ask your admin to add one in Settings → Providers.
		</p>
	{/if}
</div>

<div class="rise mt-auto flex flex-col" style="--d: 0.75s">
	<StepFooter {onnext} nextLabel="Let’s go" center>
		{#snippet secondary()}
			<span class="order-last text-sm text-muted-foreground">
				{stepCount} short steps · about 2 minutes
			</span>
		{/snippet}
	</StepFooter>
</div>

<style>
	.rise {
		animation: rise 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
		animation-delay: var(--d, 0s);
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
	}

	.welcome-mark {
		animation: pop 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: scale(0.6) rotate(-8deg);
		}
	}
	.chevron {
		stroke-dasharray: 1;
		animation: draw 0.7s 0.35s ease-out both;
	}
	@keyframes draw {
		from {
			stroke-dashoffset: 1;
		}
		to {
			stroke-dashoffset: 0;
		}
	}
	.cursor {
		animation: blink 1.06s 1s steps(1) infinite both;
	}
	@keyframes blink {
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
		.rise,
		.welcome-mark,
		.chevron,
		.cursor {
			animation: none;
		}
	}
</style>
