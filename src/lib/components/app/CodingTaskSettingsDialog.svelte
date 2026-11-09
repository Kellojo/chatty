<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import InfoIcon from '@lucide/svelte/icons/info';
	import type { CodingAutonomy, CodingConversation } from '$lib/coding-environments.js';
	import { autonomyFromRuntimeMode, runtimeModeLabel } from '$lib/coding-task-details.js';
	import { AUTONOMY_OPTIONS, CodingTaskState } from '$lib/state/coding-task.svelte.js';
	import CodingModelSelect from './CodingModelSelect.svelte';

	/**
	 * Changes a task's model and permissions (PATCH /api/coding/tasks/[id]). The
	 * task view picks up the result from the `coding.task.updated` event.
	 */
	let { coding, open = $bindable(false) }: { coding: CodingConversation; open?: boolean } =
		$props();

	let task = $state<CodingTaskState | null>(null);
	/** The task's autonomy, null when its runtime mode isn't one Chatty offers. */
	let initialAutonomy = $state<CodingAutonomy | null>(null);
	let autonomy = $state<CodingAutonomy | ''>('');
	let saving = $state(false);

	// A fresh picker each time it opens, starting from the task's current settings.
	$effect(() => {
		if (open) untrack(start);
	});

	function start() {
		if (!coding.environmentId) return;
		const current = autonomyFromRuntimeMode(coding.runtimeMode);
		initialAutonomy = current;
		autonomy = current ?? '';
		const state = new CodingTaskState([], {
			initial: {
				environmentId: coding.environmentId,
				projectId: coding.projectId,
				projectTitle: coding.projectTitle,
				providerInstanceId: coding.providerInstanceId,
				model: coding.model,
				autonomy: current ?? 'auto',
				workspaceMode: coding.workspaceMode,
				baseBranch: coding.baseBranch
			},
			remember: false
		});
		task = state;
		void state.selectEnvironment(coding.environmentId, { projectId: coding.projectId });
	}

	const modelChange = $derived.by(() => {
		const m = task?.selectedModel;
		if (!m || (m.providerInstanceId === coding.providerInstanceId && m.model === coding.model)) {
			return null;
		}
		return { providerInstanceId: m.providerInstanceId, model: m.model };
	});
	const autonomyChange = $derived(autonomy && autonomy !== initialAutonomy ? autonomy : null);
	const busy = $derived(coding.status === 'running' || coding.status === 'starting');
	const selectedAutonomy = $derived(AUTONOMY_OPTIONS.find((a) => a.value === autonomy) ?? null);

	async function save() {
		if (saving || (!modelChange && !autonomyChange)) return;
		saving = true;
		try {
			const res = await fetch(`/api/coding/tasks/${encodeURIComponent(coding.conversationId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					...(modelChange ?? {}),
					...(autonomyChange ? { autonomy: autonomyChange } : {})
				})
			});
			const data = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(data?.message ?? 'Could not save the change');
			open = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the change');
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="sm:max-w-md"
		showCloseButton={!saving}
		interactOutsideBehavior={saving ? 'ignore' : 'close'}
		escapeKeydownBehavior={saving ? 'ignore' : 'close'}
	>
		<Dialog.Header>
			<Dialog.Title>Model and permissions</Dialog.Title>
			<Dialog.Description>
				Choose which model works on this task and how much it may do without asking.
			</Dialog.Description>
		</Dialog.Header>

		{#if task}
			<div class="grid gap-5">
				<div class="grid gap-2">
					<Label>Model</Label>
					{#if task.optionsError}
						<p class="text-sm text-destructive">{task.optionsError}</p>
					{:else}
						<CodingModelSelect state={task} disabled={saving} class="w-full" />
					{/if}
				</div>
				<div class="grid gap-2">
					<Label>Permissions</Label>
					<Select.Root
						type="single"
						value={autonomy}
						onValueChange={(v) => (autonomy = v as CodingAutonomy)}
					>
						<Select.Trigger class="w-full" disabled={saving}>
							<span class="truncate">
								{selectedAutonomy?.label ?? runtimeModeLabel(coding.runtimeMode)}
							</span>
						</Select.Trigger>
						<Select.Content>
							{#each AUTONOMY_OPTIONS as a (a.value)}
								<Select.Item value={a.value} label={a.label}>
									<span class="flex flex-col whitespace-normal">
										<span class="flex items-center gap-1.5">
											{a.label}
											{#if a.value === initialAutonomy}
												<span
													class="rounded border border-border px-1 text-[11px] font-medium text-muted-foreground"
												>
													Current
												</span>
											{/if}
										</span>
										<span class="text-xs text-muted-foreground">{a.hint}</span>
									</span>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					{#if selectedAutonomy}
						<p class="text-xs text-muted-foreground">{selectedAutonomy.hint}</p>
					{/if}
				</div>
			</div>
		{/if}

		{#if busy}
			<p
				class="flex items-start gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
			>
				<InfoIcon class="mt-0.5 size-4 shrink-0" />
				The task is running. It finishes with its current settings; changes apply from your next message.
			</p>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" disabled={saving} onclick={() => (open = false)}>Cancel</Button>
			<Button disabled={saving || (!modelChange && !autonomyChange)} onclick={save}>
				{#if saving}<LoaderCircleIcon class="animate-spin" />{/if}
				{saving ? 'Saving…' : 'Save'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
