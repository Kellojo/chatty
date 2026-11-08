<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import CodingContextBar from './CodingContextBar.svelte';
	import CodingModelSelect from './CodingModelSelect.svelte';
	import { AUTONOMY_OPTIONS, CodingTaskState } from '$lib/state/coding-task.svelte.js';
	import type { CodingEnvironment } from '$lib/coding-environments.js';
	import type { Agent, AgentRun, Conversation } from '$lib/types.js';

	let {
		open = $bindable(false),
		conversationId,
		codingEnvironments,
		codingAgents,
		messageCount
	}: {
		open?: boolean;
		conversationId: string;
		/**
		 * Messages in the chat. While it's unchanged, reopening keeps the drafted
		 * (or edited) task instead of drafting again; without it every opening redrafts.
		 */
		messageCount?: number;
		codingEnvironments: CodingEnvironment[];
		/** The user's own coding agents. */
		codingAgents: Agent[];
	} = $props();

	/** Same limit as the server's first-message limit. */
	const MAX_PROMPT = 20_000;

	const task = new CodingTaskState(untrack(() => codingEnvironments));
	let taskInitialized = false;

	type Target = 'task' | 'agent';
	// svelte-ignore state_referenced_locally
	let target = $state<Target>(codingEnvironments.length > 0 ? 'task' : 'agent');
	// svelte-ignore state_referenced_locally
	let agentId = $state(codingAgents[0]?.id ?? '');
	const agent = $derived(codingAgents.find((a) => a.id === agentId) ?? null);

	let prompt = $state('');
	let drafting = $state(false);
	let draftError = $state<string | null>(null);
	let submitting = $state(false);
	let draftController: AbortController | null = null;
	/** The chat state (`id:count`) the current prompt was drafted from. */
	let draftedFor: string | null = null;
	/** The last LLM draft, to tell whether the user has edited it. */
	let draftedPrompt = $state('');
	/** Redraft was clicked once for this exact prompt; a second click overwrites it. */
	let redraftArmedFor = $state<string | null>(null);
	const edited = $derived(prompt.trim() !== '' && prompt !== draftedPrompt);
	const redraftArmed = $derived(redraftArmedFor === prompt);

	function redraft() {
		if (edited && !redraftArmed) {
			redraftArmedFor = prompt;
			return;
		}
		void loadDraft();
	}

	const autonomy = $derived(target === 'task' ? task.autonomy : agent?.codingTarget?.autonomy);
	const autonomyLabel = $derived(AUTONOMY_OPTIONS.find((a) => a.value === autonomy)?.label);
	const tooLong = $derived(prompt.length > MAX_PROMPT);
	const blocker = $derived.by((): string | null => {
		if (drafting) return 'Drafting the task…';
		if (!prompt.trim()) return 'Write the task first';
		if (tooLong) return `The task is too long (max ${MAX_PROMPT.toLocaleString()} characters)`;
		if (target === 'task') return task.draft ? null : (task.blocker ?? 'Choose where to run it');
		return agent ? null : 'Choose a coding agent';
	});

	async function errorMessage(res: Response, fallback: string): Promise<string> {
		const data = (await res.json().catch(() => null)) as { message?: string } | null;
		return data?.message ?? fallback;
	}

	async function loadDraft() {
		draftController?.abort();
		const controller = new AbortController();
		draftController = controller;
		drafting = true;
		draftError = null;
		redraftArmedFor = null;
		try {
			const res = await fetch(`/api/conversations/${conversationId}/handoff-draft`, {
				method: 'POST',
				signal: controller.signal
			});
			if (!res.ok) throw new Error(await errorMessage(res, 'Could not draft the task'));
			const body = (await res.json()) as { prompt: string };
			if (draftController === controller) prompt = draftedPrompt = body.prompt;
		} catch (e) {
			if (controller.signal.aborted) return;
			draftError = e instanceof Error ? e.message : 'Could not draft the task';
		} finally {
			if (draftController === controller) {
				drafting = false;
				draftController = null;
			}
		}
	}

	// Opening drafts from the chat as it is now, unless the prompt was already
	// drafted from this same chat state (then the draft and any edits are kept).
	// Closing cancels a draft still in flight.
	$effect(() => {
		if (!open) {
			untrack(() => draftController?.abort());
			return;
		}
		untrack(() => {
			if (!taskInitialized && codingEnvironments.length > 0) {
				taskInitialized = true;
				task.init();
			}
			redraftArmedFor = null;
			const key = messageCount === undefined ? null : `${conversationId}:${messageCount}`;
			if (key !== null && key === draftedFor && prompt.trim()) return;
			draftedFor = key;
			prompt = draftedPrompt = '';
			void loadDraft();
		});
	});

	async function start() {
		if (blocker || submitting) return;
		submitting = true;
		try {
			let conversation: string | null;
			if (target === 'task') {
				const res = await fetch('/api/coding/tasks', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ...task.draft, prompt })
				});
				if (!res.ok) throw new Error(await errorMessage(res, 'Could not start the coding task'));
				conversation = ((await res.json()) as { conversation: Conversation }).conversation.id;
			} else {
				const res = await fetch(`/api/agents/${agentId}/run`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ instructions: prompt })
				});
				if (!res.ok) throw new Error(await errorMessage(res, 'Could not start the coding agent'));
				conversation = ((await res.json()) as { run: AgentRun }).run.conversationId;
			}
			open = false;
			// Started: the next handoff begins from a fresh draft.
			draftedFor = null;
			toast.success('Coding agent started');
			if (conversation) await goto(resolve(`/chat/${conversation}`));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not start the coding agent');
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="sm:max-w-2xl"
		showCloseButton={!submitting}
		interactOutsideBehavior={submitting ? 'ignore' : 'close'}
		escapeKeydownBehavior={submitting ? 'ignore' : 'close'}
	>
		<Dialog.Header>
			<Dialog.Title>Hand off to a coding agent</Dialog.Title>
			<Dialog.Description>
				The coding agent hasn't seen this chat. It starts from the task below.
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid min-w-0 gap-5">
			<div class="grid gap-2">
				<div class="flex items-center justify-between gap-2">
					<Label for="handoff-prompt">Task</Label>
					<Button
						variant="ghost"
						size="xs"
						class={redraftArmed ? 'text-destructive hover:text-destructive' : undefined}
						disabled={drafting || submitting}
						onclick={redraft}
					>
						<RefreshCwIcon />
						{redraftArmed ? 'Discard edits and redraft?' : 'Redraft'}
					</Button>
				</div>
				{#if drafting}
					<div
						class="flex h-48 items-center justify-center gap-2 rounded-md border text-sm text-muted-foreground"
					>
						<LoaderCircleIcon class="size-4 animate-spin" />
						Drafting the task from this chat…
					</div>
				{:else}
					<Textarea
						id="handoff-prompt"
						bind:value={prompt}
						rows={10}
						class="max-h-[50vh]"
						disabled={submitting}
						placeholder="Describe what the coding agent should do…"
					/>
				{/if}
				{#if draftError}
					<p class="text-sm text-destructive">{draftError} You can also write the task yourself.</p>
				{/if}
				<p class="text-sm text-muted-foreground {tooLong ? 'text-destructive' : ''}">
					Review it before starting: the coding agent acts on exactly this text.
					{#if tooLong}({prompt.length.toLocaleString()} / {MAX_PROMPT.toLocaleString()}){/if}
				</p>
			</div>

			{#if codingEnvironments.length > 0 && codingAgents.length > 0}
				<Tabs.Root value={target} onValueChange={(v) => (target = v as Target)}>
					<Tabs.List class="w-full">
						<Tabs.Trigger value="task" disabled={submitting}>New coding task</Tabs.Trigger>
						<Tabs.Trigger value="agent" disabled={submitting}>Saved coding agent</Tabs.Trigger>
					</Tabs.List>
				</Tabs.Root>
			{/if}

			{#if target === 'task'}
				<div class="flex min-w-0 flex-wrap items-center gap-2">
					<CodingModelSelect state={task} disabled={submitting} />
					<CodingContextBar state={task} disabled={submitting} />
				</div>
			{:else}
				<div class="grid gap-2">
					<Label>Coding agent</Label>
					<Select.Root type="single" bind:value={agentId} disabled={submitting}>
						<Select.Trigger class="w-full">
							{agent ? agent.name : 'Choose a coding agent'}
						</Select.Trigger>
						<Select.Content>
							{#each codingAgents as option (option.id)}
								<Select.Item value={option.id}>
									{option.name}
									<span class="text-muted-foreground">· {option.codingTarget?.projectTitle}</span>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<p class="text-sm text-muted-foreground">
						Runs in {agent?.codingTarget?.projectTitle ?? 'its project'}. The agent's saved task is
						sent first, followed by the task above.
					</p>
				</div>
			{/if}

			{#if autonomy === 'full-access'}
				<p class="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
					<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
					Full access: the coding agent runs commands and changes files without asking.
				</p>
			{:else if autonomyLabel}
				<p class="text-sm text-muted-foreground">Permissions: {autonomyLabel}.</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" disabled={submitting} onclick={() => (open = false)}>Cancel</Button>
			<Button disabled={!!blocker || submitting} title={blocker ?? undefined} onclick={start}>
				{#if submitting}
					<LoaderCircleIcon class="animate-spin" />
					Starting…
				{:else}
					Start coding agent
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
