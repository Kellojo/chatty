<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import PasswordInput from '$lib/components/app/auth/PasswordInput.svelte';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import { PROVIDER_PRESETS, type ProviderPreset } from '$lib/provider-presets.js';
	import { resolveModelBrand } from '$lib/provider-brand.js';
	import StepFooter from './StepFooter.svelte';
	import type { OnboardingFlowState, OnboardingModel } from './onboarding-state.svelte.js';

	let {
		flow,
		onback,
		onnext
	}: { flow: OnboardingFlowState; onback: () => void; onnext: () => void } = $props();

	let preset = $state<ProviderPreset | null>(null);
	let name = $state('');
	let baseUrl = $state('');
	let apiKey = $state('');
	let error = $state('');
	let connecting = $state(false);
	/** Cosmetic progress while the single request runs. */
	let phase = $state(0);
	const PHASES = ['Checking your key', 'Fetching models', 'Choosing a default'];
	let phaseTimer: ReturnType<typeof setInterval> | undefined;
	onDestroy(() => clearInterval(phaseTimer));

	let changing = $state(false);
	let query = $state('');
	let saving = $state(false);
	let keyInput = $state<HTMLInputElement | null>(null);
	let urlInput = $state<HTMLInputElement | null>(null);
	let form = $state<HTMLFormElement | null>(null);

	const needsUrl = $derived(preset !== null && (preset.local || preset.id === 'custom'));
	const needsKey = $derived(preset !== null && !preset.local);
	const keyRequired = $derived(
		preset?.type === 'anthropic' || (needsKey && preset?.id !== 'custom')
	);
	const chatModels = $derived(
		(flow.connection?.models ?? []).filter((m) => m.capabilities.includes('chat'))
	);
	const filtered = $derived(
		query.trim()
			? chatModels.filter((m) =>
					`${m.displayName} ${m.modelId}`.toLowerCase().includes(query.trim().toLowerCase())
				)
			: chatModels
	);
	const pickedBrand = $derived(
		flow.defaultModel ? resolveModelBrand(flow.defaultModel, flow.defaultModel.provider) : null
	);

	async function choose(next: ProviderPreset) {
		preset = next;
		name = next.id === 'custom' ? '' : next.label;
		baseUrl = next.baseUrl;
		apiKey = '';
		error = '';
		await tick();
		(needsUrl ? urlInput : keyInput)?.focus({ preventScroll: true });
		// Once the form has slid open: on phones it sits below the grid, out of view.
		setTimeout(
			() =>
				form?.scrollIntoView({
					block: 'end',
					behavior: prefersReducedMotion.current ? 'auto' : 'smooth'
				}),
			reveal
		);
	}

	async function connect(event: SubmitEvent) {
		event.preventDefault();
		if (!preset || connecting) return;
		connecting = true;
		error = '';
		phase = 0;
		phaseTimer = setInterval(() => (phase = Math.min(phase + 1, PHASES.length - 1)), 900);
		try {
			const res = await fetch('/api/onboarding/connect-provider', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: name.trim() || preset.label,
					type: preset.type,
					baseUrl: baseUrl.trim() || null,
					apiKey: apiKey.trim() || null
				})
			});
			const body = (await res.json().catch(() => null)) as {
				message?: string;
				provider?: { name: string; baseUrl: string | null; type: string };
				models?: OnboardingModel[];
				chatModelId?: string | null;
			} | null;
			if (!res.ok || !body?.provider || !body.models) {
				throw new Error(body?.message ?? `Couldn’t connect (${res.status})`);
			}
			const provider = body.provider;
			flow.connection = { provider, models: body.models };
			const chosen =
				body.models.find((m) => m.id === body.chatModelId) ??
				(flow.defaultModel ? null : body.models.find((m) => m.capabilities.includes('chat')));
			if (chosen) flow.defaultModel = { ...chosen, provider };
		} catch (e) {
			error = e instanceof Error ? e.message : 'Couldn’t connect';
			await tick();
			(needsKey ? keyInput : urlInput)?.focus();
		} finally {
			clearInterval(phaseTimer);
			connecting = false;
		}
	}

	async function pick(model: OnboardingModel) {
		if (!flow.connection || saving) return;
		const previous = flow.defaultModel;
		flow.defaultModel = { ...model, provider: flow.connection.provider };
		changing = false;
		saving = true;
		try {
			const res = await fetch('/api/roles', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ role: 'chat', modelId: model.id })
			});
			if (!res.ok) throw new Error();
		} catch {
			flow.defaultModel = previous;
			error = 'Couldn’t save that choice. Try again.';
		} finally {
			saving = false;
		}
	}

	function later() {
		flow.modelSkipped = true;
		onnext();
	}

	const reveal = $derived(prefersReducedMotion.current ? 0 : 220);
</script>

<header class="flex flex-col gap-2">
	<p class="text-sm font-medium text-muted-foreground">Setup</p>
	<h1
		data-step-heading
		tabindex="-1"
		class="text-2xl font-semibold tracking-tight text-balance outline-none sm:text-3xl"
	>
		{flow.connection ? 'You’re connected' : 'Connect your first model'}
	</h1>
	<p class="max-w-xl text-pretty text-muted-foreground">
		{#if flow.connection}
			Every chat starts with this model. You can switch per chat, or add more providers later in
			Settings → Providers.
		{:else}
			Pick a provider to power your chats. You can add more anytime.
		{/if}
	</p>
</header>

{#if flow.connection && flow.defaultModel}
	<section
		class="mt-8 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
		aria-label="Connected provider"
	>
		<div class="flex items-center gap-3 border-b border-border/60 px-5 py-4">
			<span
				class="success-pop flex size-9 items-center justify-center rounded-full bg-success/15 text-success-foreground"
			>
				<CheckIcon class="size-5" aria-hidden="true" />
			</span>
			<div class="flex min-w-0 flex-col">
				<span class="text-sm font-medium">{flow.connection.provider.name} is connected</span>
				<span class="text-sm text-muted-foreground">
					Found {chatModels.length} chat model{chatModels.length === 1 ? '' : 's'}
				</span>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-4">
			<span class="w-full text-sm text-muted-foreground sm:w-auto">Default model</span>
			<span
				class="inline-flex min-w-0 items-center gap-2 rounded-full border border-border bg-background py-1 pr-3 pl-1.5 text-sm font-medium"
			>
				<span class="flex size-6 items-center justify-center rounded-full bg-muted">
					{#if pickedBrand}<ProviderIcon
							brand={pickedBrand}
							class="size-3.5"
							decorative
						/>{:else}<PlugIcon class="size-3.5" aria-hidden="true" />{/if}
				</span>
				<span class="truncate">{flow.defaultModel.displayName}</span>
				{#if saving}<LoaderCircleIcon class="size-3.5 animate-spin text-muted-foreground" />{/if}
			</span>
			{#if chatModels.length > 1}
				<Button
					variant="outline"
					size="sm"
					class="ml-auto"
					aria-expanded={changing}
					aria-controls="model-list"
					onclick={() => (changing = !changing)}
				>
					{changing ? 'Done' : 'Change'}
				</Button>
			{/if}
		</div>
		{#if changing}
			<div
				id="model-list"
				class="border-t border-border/60 bg-muted/30 p-3"
				transition:slide={{ duration: reveal }}
			>
				<div class="relative">
					<SearchIcon
						class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<Input
						bind:value={query}
						placeholder="Search {chatModels.length} models"
						aria-label="Search models"
						class="pl-9"
					/>
				</div>
				<ul class="mt-2 max-h-64 overflow-y-auto" role="listbox" aria-label="Chat models">
					{#each filtered as model (model.id)}
						{@const selected = model.id === flow.defaultModel?.id}
						<li role="option" aria-selected={selected}>
							<button
								type="button"
								class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
								onclick={() => pick(model)}
							>
								<span class="min-w-0 flex-1 truncate">{model.displayName}</span>
								{#if model.capabilities.includes('tool_use')}
									<span class="text-xs text-muted-foreground">tools</span>
								{/if}
								{#if model.capabilities.includes('vision')}
									<span class="text-xs text-muted-foreground">vision</span>
								{/if}
								<CheckIcon class={['size-4', !selected && 'invisible']} aria-hidden="true" />
							</button>
						</li>
					{:else}
						<li class="px-3 py-6 text-center text-sm text-muted-foreground">No models match</li>
					{/each}
				</ul>
			</div>
		{/if}
		<p class="border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
			Also used for chat titles and memory until you choose others in Settings → Defaults.
		</p>
	</section>
	{#if error}
		<p class="mt-3 text-sm text-destructive" role="alert">{error}</p>
	{/if}
	<StepFooter {onback} {onnext} busy={saving} />
{:else}
	<ul class="mt-8 grid grid-cols-3 gap-2 sm:gap-2.5 lg:grid-cols-5" aria-label="Providers">
		{#each PROVIDER_PRESETS as option (option.id)}
			{@const active = preset?.id === option.id}
			<li>
				<button
					type="button"
					aria-pressed={active}
					disabled={connecting}
					onclick={() => choose(option)}
					class={[
						'group flex h-full w-full flex-col items-start gap-2 rounded-2xl border p-2.5 text-left transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60 motion-reduce:transition-none sm:p-3',
						active
							? 'relative border-foreground bg-card shadow-md ring-2 ring-foreground'
							: 'border-border/70 bg-card/60 hover:-translate-y-0.5 hover:border-foreground/25 hover:bg-card hover:shadow-sm'
					]}
				>
					{#if active}
						<span
							class="absolute top-2.5 right-2.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"
						>
							<CheckIcon class="size-3" aria-hidden="true" />
						</span>
					{/if}
					<span
						class="flex size-8 items-center justify-center rounded-lg bg-muted transition-transform group-hover:scale-105"
					>
						{#if option.brand}<ProviderIcon
								brand={option.brand}
								class="size-5"
								decorative
							/>{:else}<PlugIcon class="size-5" aria-hidden="true" />{/if}
					</span>
					<span class="flex flex-col">
						<span class="text-sm font-medium">{option.label}</span>
						<span
							class={[
								'hidden text-xs sm:block',
								option.local ? 'text-success-foreground' : 'text-muted-foreground'
							]}>{option.blurb}</span
						>
						{#if option.local}
							<span class="text-[0.6875rem] text-success-foreground sm:hidden">No key</span>
						{/if}
					</span>
				</button>
			</li>
		{/each}
	</ul>

	{#if preset}
		<form
			bind:this={form}
			class="mt-5 flex scroll-mb-24 flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm"
			onsubmit={connect}
			oninput={() => (error = '')}
			transition:slide={{ duration: reveal }}
			aria-busy={connecting}
		>
			<fieldset disabled={connecting} class="contents">
				{#if preset.id === 'custom'}
					<div class="flex flex-col gap-2">
						<Label for="provider-name">Name</Label>
						<Input id="provider-name" bind:value={name} placeholder="My server" required />
					</div>
				{/if}
				{#if needsUrl}
					<div class="flex flex-col gap-2">
						<Label for="provider-url">Server URL</Label>
						<Input
							id="provider-url"
							type="url"
							bind:value={baseUrl}
							bind:ref={urlInput}
							placeholder="https://example.com/v1"
							class="font-mono text-[0.8125rem]"
							required
							aria-invalid={error && !needsKey ? true : undefined}
							aria-describedby={error ? 'connect-error' : undefined}
						/>
						{#if preset.local}
							<p class="text-xs text-muted-foreground">
								The URL as seen from the Chatty server. In Docker, <code class="font-mono"
									>host.docker.internal</code
								> usually reaches your machine.
							</p>
						{/if}
					</div>
				{/if}
				{#if needsKey}
					<div class="flex flex-col gap-2">
						<div class="flex items-center justify-between gap-2">
							<Label for="provider-key">API key{keyRequired ? '' : ' (optional)'}</Label>
							{#if preset.keyUrl}
								<!-- eslint-disable svelte/no-navigation-without-resolve -- external site -->
								<a
									href={preset.keyUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								>
									Get a key<ExternalLinkIcon class="size-3" aria-hidden="true" />
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{/if}
						</div>
						<PasswordInput
							id="provider-key"
							bind:value={apiKey}
							bind:ref={keyInput}
							required={keyRequired}
							autocomplete="off"
							spellcheck={false}
							class="font-mono"
							aria-invalid={error && needsKey ? true : undefined}
							aria-describedby="key-hint{error ? ' connect-error' : ''}"
						/>
						<p id="key-hint" class="flex items-center gap-1.5 text-xs text-muted-foreground">
							<LockIcon class="size-3" aria-hidden="true" />Encrypted on your server. Never shown
							again.
						</p>
					</div>
				{/if}

				{#if error}
					<p
						id="connect-error"
						class="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
						role="alert"
					>
						<CircleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{error}
					</p>
				{/if}

				<div class="flex flex-wrap items-center gap-3">
					<Button type="submit" size="lg" disabled={connecting}>
						{#if connecting}<LoaderCircleIcon class="animate-spin" />{/if}
						{connecting ? 'Connecting…' : `Connect ${preset.id === 'custom' ? '' : preset.label}`}
					</Button>
					{#if connecting}
						<span class="text-sm text-muted-foreground" aria-live="polite">{PHASES[phase]}…</span>
					{/if}
				</div>
			</fieldset>
		</form>
	{/if}

	<StepFooter {onback}>
		{#snippet secondary()}
			<Button
				variant="link"
				class="text-muted-foreground hover:text-foreground"
				disabled={connecting}
				onclick={later}
			>
				I’ll do this later
			</Button>
		{/snippet}
	</StepFooter>
{/if}

<style>
	.success-pop {
		animation: success-pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}
	@keyframes success-pop {
		from {
			transform: scale(0.4);
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.success-pop {
			animation: none;
		}
	}
</style>
