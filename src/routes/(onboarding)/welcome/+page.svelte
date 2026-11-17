<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { goto } from '$app/navigation';
	import { prefersReducedMotion } from 'svelte/motion';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import OnboardingProgress from '$lib/components/app/onboarding/OnboardingProgress.svelte';
	import StepWelcome from '$lib/components/app/onboarding/StepWelcome.svelte';
	import StepModel from '$lib/components/app/onboarding/StepModel.svelte';
	import StepPersonalize from '$lib/components/app/onboarding/StepPersonalize.svelte';
	import StepConcepts from '$lib/components/app/onboarding/StepConcepts.svelte';
	import StepReady from '$lib/components/app/onboarding/StepReady.svelte';
	import { OnboardingFlowState } from '$lib/components/app/onboarding/onboarding-state.svelte.js';
	import { STEP_LABELS, type OnboardingStep } from '$lib/onboarding.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const flow = new OnboardingFlowState(
		untrack(() => ({
			step: data.initialStep,
			theme: data.theme,
			instructions: data.globalInstructions,
			defaultModel: data.defaultModel
		}))
	);

	const firstName = $derived(
		data.user.name.trim().split(/\s+/)[0] || data.user.email.split('@')[0] || 'there'
	);
	const index = $derived(data.steps.indexOf(flow.step));
	const hasModel = $derived(flow.defaultModel !== null);

	let stage = $state<HTMLElement | null>(null);
	let skipOpen = $state(false);
	let finishing = $state(false);
	let finishError = $state('');

	async function saveStep(step: OnboardingStep) {
		if (data.replay) return;
		// Only for resuming after a reload: a failed write costs nothing else.
		await fetch('/api/user/onboarding', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ step })
		}).catch(() => undefined);
	}

	async function go(delta: 1 | -1) {
		const next = data.steps[index + delta];
		if (!next) return;
		flow.direction = delta;
		flow.step = next;
		void saveStep(next);
		await tick();
		// Screen readers and keyboards start from the new screen's heading.
		stage?.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true });
		stage?.closest('main')?.scrollTo({ top: 0 });
	}

	/** Leaves the flow. Awaited, so a failed save can't bounce the user back here. */
	async function finish(status: 'done' | 'skipped', target: string) {
		if (finishing) return;
		finishing = true;
		finishError = '';
		try {
			if (!data.replay) {
				const res = await fetch('/api/user/onboarding', {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ status })
				});
				if (!res.ok) throw new Error(`Request failed (${res.status})`);
			}
			// A full reload of the app's data, which no longer redirects here.
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- same-site paths built here
			await goto(target, { invalidateAll: true });
		} catch {
			finishError = 'Couldn’t save your progress. Check your connection and try again.';
			finishing = false;
		}
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.defaultPrevented || skipOpen) return;
		const target = event.target as HTMLElement;
		// Only from "nowhere in particular": fields, buttons and links keep their own Enter.
		if (target !== document.body && !target.hasAttribute('data-step-heading')) return;
		event.preventDefault();
		stage?.querySelector<HTMLButtonElement>('[data-primary]:not(:disabled)')?.click();
	}

	const slide = $derived(prefersReducedMotion.current ? 0 : 16);
	const duration = $derived(prefersReducedMotion.current ? 0 : 240);
</script>

<svelte:head>
	<title>Welcome · Chatty</title>
</svelte:head>

<svelte:window {onkeydown} />

<main
	class="onboarding-bg relative flex h-dvh flex-col overflow-x-hidden overflow-y-auto bg-background"
>
	<header
		class="sticky top-0 z-10 flex items-center gap-4 bg-background/70 px-4 pt-[calc(0.75rem+var(--app-top))] pb-3 backdrop-blur-md sm:px-6"
	>
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<svg
				viewBox="0 0 24 24"
				class="size-7 shrink-0 rounded-lg bg-foreground text-background"
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
					<path d="M12.5 18h6" />
				</g>
			</svg>
			<span class="text-sm font-semibold tracking-tight">Chatty</span>
		</div>
		<OnboardingProgress steps={data.steps} current={index} />
		<div class="flex flex-1 justify-end">
			{#if flow.step !== 'ready'}
				<Button
					variant="ghost"
					size="sm"
					class="text-muted-foreground"
					onclick={() => (data.replay ? finish('done', data.next) : (skipOpen = true))}
				>
					{data.replay ? 'Close' : 'Skip setup'}
				</Button>
			{/if}
		</div>
	</header>

	<p class="sr-only" aria-live="polite">
		Step {index + 1} of {data.steps.length}: {STEP_LABELS[flow.step]}
	</p>

	<div bind:this={stage} class="grid flex-1 px-4 sm:px-6">
		{#key flow.step}
			<div
				class="col-start-1 row-start-1 mx-auto flex w-full max-w-3xl flex-col pt-6 sm:pt-10"
				in:fly={{ x: slide * flow.direction, duration, delay: duration * 0.4, easing: cubicOut }}
				out:fade={{ duration: duration * 0.5 }}
			>
				{#if flow.step === 'welcome'}
					<StepWelcome
						{firstName}
						isAdmin={data.isAdmin}
						{hasModel}
						stepCount={data.steps.length}
						privateDataEnabled={data.privateDataEnabled}
						onnext={() => go(1)}
					/>
				{:else if flow.step === 'model'}
					<StepModel {flow} onback={() => go(-1)} onnext={() => go(1)} />
				{:else if flow.step === 'personalize'}
					<StepPersonalize {flow} onback={() => go(-1)} onnext={() => go(1)} />
				{:else if flow.step === 'concepts'}
					<StepConcepts
						isAdmin={data.isAdmin}
						privateDataEnabled={data.privateDataEnabled}
						{hasModel}
						onback={() => go(-1)}
						onnext={() => go(1)}
					/>
				{:else}
					<StepReady
						{flow}
						{firstName}
						isAdmin={data.isAdmin}
						suggestions={data.suggestions}
						setup={data.setup}
						next={data.next}
						{finishing}
						error={finishError}
						onback={index > 0 ? () => go(-1) : undefined}
						onfinish={(target) => finish('done', target)}
					/>
				{/if}
			</div>
		{/key}
	</div>
</main>

<Dialog.Root bind:open={skipOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Skip setup?</Dialog.Title>
			<Dialog.Description>
				{#if data.isAdmin && !hasModel}
					Chats need a model, so you’ll want to connect one in Settings → Providers.
				{/if}
				You can replay this tour anytime from Settings → Account.
			</Dialog.Description>
		</Dialog.Header>
		{#if finishError}
			<p class="text-sm text-destructive" role="alert">{finishError}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (skipOpen = false)}>Keep going</Button>
			<Button disabled={finishing} onclick={() => finish('skipped', data.next)}>Skip setup</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	/* The same soft top light as the sign-in pages (AuthShell). */
	.onboarding-bg {
		background-image: radial-gradient(
			ellipse 60% 40% at 50% 0%,
			color-mix(in oklch, var(--foreground) 6%, transparent),
			transparent
		);
	}
</style>
