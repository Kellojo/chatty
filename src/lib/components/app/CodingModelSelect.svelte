<script lang="ts">
	import * as Select from '$lib/components/ui/select/index.js';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import ProviderIcon from './ProviderIcon.svelte';
	import ModelOptionItem from './ModelOptionItem.svelte';
	import ModelFavoritesGroup from './ModelFavoritesGroup.svelte';
	import { resolveBrand } from '$lib/provider-brand.js';
	import { codingFavoriteKey, getFavoriteModels } from '$lib/state/favorite-models.svelte.js';
	import { encodeCodingModel, type CodingTaskState } from '$lib/state/coding-task.svelte.js';
	import type { CodingModelOption } from '$lib/coding-environments.js';

	let {
		state: task,
		disabled = false,
		class: triggerClass = 'w-40 sm:w-64'
	}: {
		state: CodingTaskState;
		disabled?: boolean;
		/** Sizing for the trigger; defaults to the compact toolbar width. */
		class?: string;
	} = $props();

	const favorites = getFavoriteModels();

	const empty = $derived(!task.options || task.options.models.length === 0);
	const label = $derived.by(() => {
		if (task.optionsLoading) return 'Loading models…';
		if (task.selectedModel) return task.selectedModel.label;
		if (task.options && task.options.models.length === 0) return 'No coding agents';
		return 'Model';
	});
	const brandOf = (m: CodingModelOption) => resolveBrand(m.provider, m.providerLabel);
	const brand = $derived(task.selectedModel ? brandOf(task.selectedModel) : null);
	const defaultValue = $derived(task.defaultModel ? encodeCodingModel(task.defaultModel) : '');

	// Starred in Chatty or in T3; Chatty's own stars first, in starring order.
	const isOwnFavorite = (m: CodingModelOption) => favorites?.has(codingFavoriteKey(m)) ?? false;
	const isFavorite = (m: CodingModelOption) => m.favorite || isOwnFavorite(m);
	const favoriteModels = $derived.by(() => {
		const models = task.options?.models ?? [];
		const byKey = new Map(models.map((m) => [codingFavoriteKey(m), m]));
		const own = (favorites?.refs ?? []).flatMap((key) => byKey.get(key) ?? []);
		return [...own, ...models.filter((m) => m.favorite && !own.includes(m))];
	});
	const otherGroups = $derived(
		task.modelGroups
			.map((g) => ({ label: g.label, models: g.models.filter((m) => !isFavorite(m)) }))
			.filter((g) => g.models.length > 0)
	);
</script>

{#snippet item(m: CodingModelOption, showSource = false)}
	{@const value = encodeCodingModel(m)}
	<ModelOptionItem
		{value}
		name={m.label}
		brand={brandOf(m)}
		source={showSource ? m.providerLabel : undefined}
		favoriteKey={codingFavoriteKey(m)}
		lockedFavorite={m.favorite ? 'Favorite in T3; change it there' : undefined}
	>
		{#snippet badges()}
			{#if value === defaultValue}
				<span
					class="rounded border border-border px-1 text-[11px] font-medium text-muted-foreground"
					title="T3's default model for this project"
				>
					Default
				</span>
			{/if}
		{/snippet}
	</ModelOptionItem>
{/snippet}

<Select.Root type="single" value={task.modelValue} onValueChange={(v) => task.setModel(v)}>
	<Select.Trigger
		class={triggerClass}
		disabled={disabled || empty}
		title={task.selectedModel
			? `${task.selectedModel.providerLabel} · ${task.selectedModel.label}`
			: label}
	>
		<span class="flex min-w-0 flex-1 items-center gap-1.5 text-left">
			{#if task.optionsLoading}
				<LoaderCircleIcon class="size-3.5 animate-spin text-muted-foreground" />
			{/if}
			{#if brand && !task.optionsLoading}
				<ProviderIcon {brand} class="size-3.5 shrink-0" />
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
		<ModelFavoritesGroup count={favoriteModels.length}>
			{#each favoriteModels as m (encodeCodingModel(m))}
				{@render item(m, true)}
			{/each}
		</ModelFavoritesGroup>
		{#each otherGroups as group (group.label)}
			{@const groupBrand = group.models[0] ? brandOf(group.models[0]) : null}
			<Select.Group>
				<Select.Label class="flex items-center gap-1.5">
					{#if groupBrand}<ProviderIcon brand={groupBrand} class="size-3 shrink-0" />{/if}
					{group.label}
				</Select.Label>
				{#each group.models as m (encodeCodingModel(m))}
					{@render item(m)}
				{/each}
			</Select.Group>
		{/each}
	</Select.Content>
</Select.Root>
