<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { MAX_PREFILL_PROMPT_LENGTH } from '$lib/onboarding.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import NotebookPenIcon from '@lucide/svelte/icons/notebook-pen';
	import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let {
		environmentName,
		projectTitle,
		text,
		autoStart,
		error = null,
		starting = false,
		onstart,
		onautostart
	}: {
		environmentName: string | null;
		projectTitle: string;
		/** The draft's message, offered for rewriting as a new task. */
		text: string;
		/** Starts by itself once the environment is back online. */
		autoStart: boolean;
		/** Why it couldn't start (auto-start is off after such an error). */
		error?: string | null;
		starting?: boolean;
		onstart: () => void;
		onautostart: (on: boolean) => void;
	} = $props();

	const uid = $props.id();
	const env = $derived(environmentName ?? 'its environment');
	// The Code tab with this text filled in, to pick another project or model.
	const rewriteHref = $derived(
		`${resolve('/')}?${new URLSearchParams({
			mode: 'coding',
			prompt: text.slice(0, MAX_PREFILL_PROMPT_LENGTH)
		})}`
	);
</script>

{#snippet startButton(variant: 'default' | 'outline', label: string)}
	<Button
		size="sm"
		{variant}
		class="shrink-0 rounded-full"
		disabled={starting}
		title="Send it to {env} now"
		onclick={onstart}
	>
		{#if starting}
			<LoaderCircleIcon class="size-4 animate-spin" />
			Starting…
		{:else}
			<ArrowUpIcon class="size-4" />
			{label}
		{/if}
	</Button>
{/snippet}

<!-- Takes the composer's place: a draft holds one task until it's started. -->
<div class="rounded-3xl border bg-muted/30 px-4 py-3" role="region" aria-label="Draft task">
	<div class="flex items-center gap-3">
		<NotebookPenIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<div class="min-w-0 flex-1">
			<p class="text-sm font-medium">Draft · not sent yet</p>
			<p class="truncate text-xs text-muted-foreground">{projectTitle} · {env}</p>
		</div>
		{#if !error}{@render startButton('default', 'Start now')}{/if}
	</div>

	<div class="mt-3 flex flex-col gap-3 border-t pt-3" aria-live="polite">
		{#if error}
			<!-- A start would most likely fail again: rewriting it is the way forward. -->
			<div class="flex flex-col gap-2.5">
				<div class="flex items-start gap-2" role="alert">
					<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
					<div class="min-w-0">
						<p class="text-sm break-words text-destructive">{error}</p>
						<p class="text-xs text-muted-foreground">
							Rewrite it to pick another project or model, or try again once it's fixed.
						</p>
					</div>
				</div>
				<!-- Phones: stacked full width, the primary action on top. -->
				<div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end [&>*]:max-sm:w-full">
					{@render startButton('outline', 'Try again')}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved above -->
					<Button href={rewriteHref} size="sm" class="shrink-0 rounded-full">
						<PencilLineIcon class="size-4" />
						Rewrite as a new task
					</Button>
				</div>
			</div>
		{/if}
		<!-- Stays in place while starting (switch disabled), so the card doesn't jump. -->
		<div class="flex items-center gap-3">
			<div class="min-w-0 flex-1">
				<label for="{uid}-auto" class="cursor-pointer text-xs font-medium">
					Start automatically
				</label>
				<p class="flex items-start gap-1.5 text-xs text-muted-foreground">
					{#if starting}
						<span>Sending to {env}…</span>
					{:else if autoStart}
						<span
							class="mt-1 size-2 shrink-0 animate-[pulse_3s_ease-in-out_infinite] rounded-full bg-info motion-reduce:animate-none"
							aria-hidden="true"
						></span>
						<span>
							Waiting for {env}<span class="max-sm:hidden"> · checks every minute</span>
						</span>
					{:else if error}
						<span>Off since the error · turn it on to retry by itself</span>
					{:else}
						<span>Off · start it yourself</span>
					{/if}
				</p>
			</div>
			<Switch
				id="{uid}-auto"
				checked={autoStart}
				disabled={starting}
				onCheckedChange={onautostart}
			/>
		</div>
	</div>
</div>
