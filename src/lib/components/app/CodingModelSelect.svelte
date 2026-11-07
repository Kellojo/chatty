<script lang="ts">
	import * as Select from '$lib/components/ui/select/index.js';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { encodeCodingModel, type CodingTaskState } from '$lib/state/coding-task.svelte.js';

	let { state: task, disabled = false }: { state: CodingTaskState; disabled?: boolean } = $props();

	const empty = $derived(!task.options || task.options.models.length === 0);
	const label = $derived.by(() => {
		if (task.optionsLoading) return 'Loading models…';
		if (task.selectedModel) return task.selectedModel.label;
		if (task.options && task.options.models.length === 0) return 'No coding agents';
		return 'Model';
	});
</script>

<Select.Root type="single" value={task.modelValue} onValueChange={(v) => task.setModel(v)}>
	<Select.Trigger
		class="w-40 sm:w-64"
		disabled={disabled || empty}
		title={task.selectedModel
			? `${task.selectedModel.providerLabel} · ${task.selectedModel.label}`
			: label}
	>
		<span class="flex min-w-0 flex-1 items-center gap-1.5 text-left">
			{#if task.optionsLoading}
				<LoaderCircleIcon class="size-3.5 animate-spin text-muted-foreground" />
			{/if}
			<span class="truncate">{label}</span>
			{#if task.selectedModel && !task.selectedModel.label.includes(task.selectedModel.providerLabel)}
				<span class="hidden shrink-0 text-xs text-muted-foreground sm:inline">
					{task.selectedModel.providerLabel}
				</span>
			{/if}
		</span>
	</Select.Trigger>
	<Select.Content class="max-h-[min(24rem,var(--bits-select-content-available-height))] min-w-64">
		{#each task.modelGroups as group (group.label)}
			<Select.Group>
				<Select.Label>{group.label}</Select.Label>
				{#each group.models as m (encodeCodingModel(m))}
					<Select.Item value={encodeCodingModel(m)}>{m.label}</Select.Item>
				{/each}
			</Select.Group>
		{/each}
	</Select.Content>
</Select.Root>
