<script lang="ts">
	// Screenshot harness for offline coding drafts: the start page's composer while
	// the environment is offline, and the draft card that replaces a chat's composer.
	import { onMount } from 'svelte';
	import {
		PromptInput,
		PromptInputTextarea,
		PromptInputActions
	} from '$lib/components/ai/prompt-input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import CodingModelSelect from '$lib/components/app/CodingModelSelect.svelte';
	import CodingContextBar from '$lib/components/app/CodingContextBar.svelte';
	import CodingDraftCard from '$lib/components/app/CodingDraftCard.svelte';
	import { CodingTaskState } from '$lib/state/coding-task.svelte.js';
	import type { CodingEnvironment } from '$lib/coding-environments.js';

	let {
		kind,
		autoStart = true,
		error = null,
		starting = false
	}: {
		kind: 'start' | 'draft';
		autoStart?: boolean;
		error?: string | null;
		starting?: boolean;
	} = $props();

	const env: CodingEnvironment = {
		id: 'env-1',
		name: 'workstation',
		baseUrl: 'http://workstation:3773',
		enabled: true,
		status: 'error',
		serverVersion: null,
		environmentLabel: null,
		lastError: null,
		lastCheckedAt: null,
		lastSyncedAt: null,
		createdAt: 0
	};
	const task = new CodingTaskState([env], { offlineDrafts: true });
	let input = $state('Add a dark mode toggle to the settings page');
	let auto = $state(autoStart);

	onMount(() => {
		if (kind === 'start') task.init();
	});
</script>

{#if kind === 'start'}
	<div class="mx-auto flex w-full max-w-2xl flex-col items-center gap-5 pt-6">
		<h1 class="text-center text-2xl font-semibold">What are we working on?</h1>
		<div class="w-full">
			<PromptInput value={input} onValueChange={(v) => (input = v)}>
				<PromptInputTextarea placeholder="Describe a task…" />
				<PromptInputActions class="justify-between">
					<div class="flex min-w-0 items-center gap-1">
						<CodingModelSelect state={task} />
					</div>
					<Button size="sm" aria-label="Send" disabled={!task.draft}>
						<ArrowUpIcon class="size-4" />
					</Button>
				</PromptInputActions>
			</PromptInput>
			<div class="relative mt-3">
				<CodingContextBar state={task} />
			</div>
		</div>
	</div>
{:else}
	<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-6">
		<div class="ml-auto max-w-[80%] rounded-3xl bg-muted px-4 py-2.5 text-sm">
			Add a dark mode toggle to the settings page. Keep the current light theme as default and
			remember the choice per device.
		</div>
		<div class="mt-24">
			<CodingDraftCard
				environmentName="workstation"
				projectTitle="ai-chat"
				autoStart={auto}
				{error}
				{starting}
				onstart={() => {}}
				text="Add a dark mode toggle to the settings page. Keep the current light theme as default and remember the choice per device."
				onautostart={(on) => (auto = on)}
			/>
		</div>
	</div>
{/if}
