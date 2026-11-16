<script lang="ts">
	import { prefersReducedMotion } from 'svelte/motion';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CodeIcon from '@lucide/svelte/icons/code';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import BlocksIcon from '@lucide/svelte/icons/blocks';
	import MicIcon from '@lucide/svelte/icons/mic';
	import PaletteIcon from '@lucide/svelte/icons/palette';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UsersIcon from '@lucide/svelte/icons/users';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import { MAX_PREFILL_PROMPT_LENGTH } from '$lib/onboarding.js';
	import { resolveModelBrand } from '$lib/provider-brand.js';
	import Celebration from './Celebration.svelte';
	import StepFooter from './StepFooter.svelte';
	import type { OnboardingFlowState } from './onboarding-state.svelte.js';

	let {
		flow,
		firstName,
		isAdmin,
		suggestions,
		setup,
		next,
		finishing,
		error,
		onback,
		onfinish
	}: {
		flow: OnboardingFlowState;
		firstName: string;
		isAdmin: boolean;
		suggestions: string[];
		setup: { webSearch: boolean; voice: boolean; tools: boolean; people: boolean } | null;
		next: string;
		finishing: boolean;
		error: string;
		onback?: () => void;
		/** Leaves onboarding for a same-site path. */
		onfinish: (target: string) => void;
	} = $props();

	const model = $derived(flow.defaultModel);
	const brand = $derived(model ? resolveModelBrand(model, model.provider) : null);
	const themeLabel = $derived(
		flow.theme === 'system' ? 'Follows your system' : flow.theme === 'dark' ? 'Dark' : 'Light'
	);
	const hasInstructions = $derived(flow.savedInstructions.trim().length > 0);

	const finishSetup = $derived(
		setup
			? [
					{
						done: setup.webSearch,
						icon: GlobeIcon,
						label: 'Web search',
						text: 'Add SearXNG, Brave or Perplexity for sharper results',
						href: '/settings/services'
					},
					{
						done: setup.voice,
						icon: MicIcon,
						label: 'Voice',
						text: 'Pick speech models for dictation and read-aloud',
						href: '/settings/defaults'
					},
					{
						done: setup.tools,
						icon: BlocksIcon,
						label: 'Tools',
						text: 'Connect MCP servers to give models new abilities',
						href: '/settings/mcp'
					},
					{
						done: setup.people,
						icon: UsersIcon,
						label: 'People',
						text: 'Invite others to this Chatty',
						href: '/settings/users'
					}
				]
			: []
	);

	const explore = [
		{ icon: CodeIcon, label: 'Coding', href: '/settings/environments' },
		{ icon: KeyRoundIcon, label: 'API keys', href: '/settings/api' },
		{ icon: ScrollTextIcon, label: 'Skills', href: '/skills' }
	];

	function startWith(prompt: string) {
		onfinish(`/?prompt=${encodeURIComponent(prompt.slice(0, MAX_PREFILL_PROMPT_LENGTH))}`);
	}
</script>

<div class="flex flex-col items-center text-center">
	<div class="relative mb-5 flex size-16 items-center justify-center">
		{#if !prefersReducedMotion.current}<Celebration />{/if}
		<span
			class="done-badge relative flex size-16 items-center justify-center rounded-full bg-foreground text-background shadow-lg"
		>
			<CheckIcon class="size-8" strokeWidth={2.5} aria-hidden="true" />
		</span>
	</div>
	<h1
		data-step-heading
		tabindex="-1"
		class="text-3xl font-semibold tracking-tight text-balance outline-none sm:text-4xl"
	>
		You’re all set, {firstName}
	</h1>
	<p class="mt-3 max-w-md text-pretty text-muted-foreground">
		{model
			? 'Pick a first prompt, or start with your own.'
			: isAdmin
				? 'Almost there: connect a model to start chatting.'
				: 'Chats unlock as soon as your admin connects a model.'}
	</p>
</div>

<ul
	class="mx-auto mt-8 grid w-full max-w-xl gap-px overflow-hidden rounded-2xl border border-border/70 bg-border/60 shadow-xs"
	aria-label="Summary"
>
	<li class="flex items-center gap-3 bg-card px-4 py-3">
		{#if model}
			<span class="flex size-8 items-center justify-center rounded-lg bg-muted">
				{#if brand}<ProviderIcon {brand} class="size-4" decorative />{:else}<PlugIcon
						class="size-4"
						aria-hidden="true"
					/>{/if}
			</span>
			<span class="flex min-w-0 flex-1 flex-col text-left">
				<span class="text-xs text-muted-foreground">Default model</span>
				<span class="truncate text-sm font-medium">{model.displayName}</span>
			</span>
			<CheckIcon class="size-4 text-success-foreground" aria-label="Done" />
		{:else}
			<span
				class="flex size-8 items-center justify-center rounded-lg bg-warning/15 text-warning-foreground"
			>
				<TriangleAlertIcon class="size-4" aria-hidden="true" />
			</span>
			<span class="flex min-w-0 flex-1 flex-col text-left">
				<span class="text-xs text-muted-foreground">Default model</span>
				<span class="text-sm font-medium">
					{isAdmin ? 'No model connected yet' : 'Waiting for your admin to connect one'}
				</span>
			</span>
			{#if isAdmin}
				<button
					type="button"
					class="text-sm font-medium underline-offset-4 hover:underline"
					onclick={() => onfinish('/settings/providers')}
				>
					Connect
				</button>
			{/if}
		{/if}
	</li>
	<li class="flex items-center gap-3 bg-card px-4 py-3">
		<span class="flex size-8 items-center justify-center rounded-lg bg-muted">
			<PaletteIcon class="size-4" aria-hidden="true" />
		</span>
		<span class="flex flex-1 flex-col text-left">
			<span class="text-xs text-muted-foreground">Theme</span>
			<span class="text-sm font-medium">{themeLabel}</span>
		</span>
		<CheckIcon class="size-4 text-success-foreground" aria-label="Done" />
	</li>
	<li class="flex items-center gap-3 bg-card px-4 py-3">
		<span class="flex size-8 items-center justify-center rounded-lg bg-muted">
			<ScrollTextIcon class="size-4" aria-hidden="true" />
		</span>
		<span class="flex flex-1 flex-col text-left">
			<span class="text-xs text-muted-foreground">Custom instructions</span>
			<span class="text-sm font-medium">
				{#if hasInstructions}Saved{:else}None yet <span class="font-normal text-muted-foreground"
						>· add them anytime in Settings → Conversation</span
					>{/if}
			</span>
		</span>
		{#if hasInstructions}
			<CheckIcon class="size-4 text-success-foreground" aria-label="Done" />
		{:else}
			<span class="text-xs font-medium text-foreground/70">Optional</span>
		{/if}
	</li>
</ul>

{#if model}
	<section class="mx-auto mt-8 w-full max-w-xl" aria-labelledby="starters-title">
		<h2 id="starters-title" class="text-sm font-medium">Try one of these</h2>
		<ul class="mt-3 grid gap-2 sm:grid-cols-3">
			{#each suggestions as suggestion, i (suggestion)}
				<li class="starter" style="--d: {0.15 + i * 0.07}s">
					<button
						type="button"
						disabled={finishing}
						onclick={() => startWith(suggestion)}
						class="group flex h-full w-full items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card p-3.5 text-left text-sm shadow-xs transition-all outline-none hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60 motion-reduce:transition-none sm:flex-col sm:items-stretch sm:gap-4"
					>
						<span class="text-pretty">{suggestion}</span>
						<ArrowUpRightIcon
							class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground sm:self-end"
							aria-hidden="true"
						/>
					</button>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if finishSetup.length > 0}
	<section class="mx-auto mt-8 w-full max-w-xl" aria-labelledby="instance-title">
		<div class="flex items-baseline justify-between gap-2">
			<h2 id="instance-title" class="text-sm font-medium">Finish your instance</h2>
			<span class="text-xs text-muted-foreground">Optional · as admin</span>
		</div>
		<ul class="mt-3 grid gap-2 sm:grid-cols-2">
			{#each finishSetup as item (item.label)}
				<li>
					<button
						type="button"
						disabled={finishing}
						onclick={() => onfinish(item.href)}
						class="group flex h-full w-full items-start gap-3 rounded-2xl border border-border/70 bg-card/70 p-3 text-left transition-colors outline-none hover:border-foreground/25 hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
					>
						<span
							class={[
								'flex size-8 shrink-0 items-center justify-center rounded-lg',
								item.done ? 'bg-success/15 text-success-foreground' : 'bg-muted'
							]}
						>
							{#if item.done}<CheckIcon class="size-4" aria-hidden="true" />{:else}<item.icon
									class="size-4"
									aria-hidden="true"
								/>{/if}
						</span>
						<span class="flex min-w-0 flex-1 flex-col">
							<span class="text-sm font-medium">
								{item.label}{#if item.done}<span class="font-normal text-muted-foreground">
										· set up</span
									>{/if}
							</span>
							<span class="text-xs text-muted-foreground">{item.text}</span>
						</span>
						<ArrowRightIcon
							class="mt-2 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
							aria-hidden="true"
						/>
					</button>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<nav
	class="mx-auto mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-muted-foreground"
	aria-label="More to explore"
>
	<span>More to explore:</span>
	{#each explore as link (link.label)}
		<button
			type="button"
			disabled={finishing}
			onclick={() => onfinish(link.href)}
			class="inline-flex items-center gap-1.5 rounded-md underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
		>
			<link.icon class="size-3.5" aria-hidden="true" />{link.label}
		</button>
	{/each}
</nav>

{#if error}
	<p class="mt-6 text-center text-sm text-destructive" role="alert">{error}</p>
{/if}

<StepFooter
	{onback}
	onnext={() => onfinish(next)}
	nextLabel={error ? 'Try again' : model ? 'Start chatting' : 'Go to Chatty'}
	busy={finishing}
/>

<style>
	.done-badge {
		animation: badge 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}
	@keyframes badge {
		from {
			transform: scale(0.3);
			opacity: 0;
		}
	}
	.starter {
		animation: rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
		animation-delay: var(--d);
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.done-badge,
		.starter {
			animation: none;
		}
	}
</style>
