<script lang="ts">
	import { untrack } from 'svelte';
	import SearchIcon from '@lucide/svelte/icons/search';
	import * as Select from '$lib/components/ui/select/index.js';
	import { mappingModelRef, encodeModelRef } from '$lib/model-ref.js';
	import ProviderIcon from './ProviderIcon.svelte';
	import ModelOptionItem from './ModelOptionItem.svelte';
	import ModelFavoritesGroup from './ModelFavoritesGroup.svelte';
	import {
		resolveBrand,
		resolveModelBrand,
		resolveProviderBrand,
		type Brand
	} from '$lib/provider-brand.js';
	import { getFavoriteModels } from '$lib/state/favorite-models.svelte.js';
	import type { ChatModel, ModelMapping, ModelsByProvider, Provider } from '$lib/types.js';

	let {
		groups,
		mappings = [],
		value = $bindable(''),
		onselect,
		disabled = false,
		placeholder = 'Select model',
		noneValue,
		noneLabel = 'Not set',
		capability,
		class: className = 'w-64'
	}: {
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		value: string;
		onselect: (value: string) => void;
		disabled?: boolean;
		placeholder?: string;
		noneValue?: string;
		noneLabel?: string;
		capability?: string;
		class?: string;
	} = $props();

	const favorites = getFavoriteModels();

	let selectedValue = $state(untrack(() => value));
	let query = $state('');

	$effect(() => {
		if (selectedValue !== value) {
			selectedValue = value;
		}
	});

	interface Option {
		value: string;
		name: string;
		/** Where the model comes from; shown next to favourites, which leave their group. */
		source: string;
		brand: Brand | null;
	}

	const mappingOption = (mapping: ModelMapping): Option => ({
		value: encodeModelRef(mappingModelRef(mapping)),
		name: mapping.name,
		source: 'Mapping',
		brand:
			resolveBrand(mapping.name) ??
			(mapping.targets[0] ? resolveModelBrand(mapping.targets[0]) : null)
	});

	const modelOption = (model: ChatModel, provider: Provider): Option => ({
		value: `${model.providerId}/${model.modelId}`,
		name: model.displayName,
		source: provider.name,
		brand: resolveModelBrand(model, provider)
	});

	const selected = $derived.by(() => {
		for (const mapping of mappings) {
			const option = mappingOption(mapping);
			if (option.value === selectedValue) return { label: `${option.name} (mapping)`, ...option };
		}
		for (const { provider, models } of groups) {
			for (const model of models) {
				const option = modelOption(model, provider);
				if (option.value === selectedValue) {
					return { label: `${option.name} (${provider.name})`, ...option };
				}
			}
		}
		const fallback = selectedValue
			? selectedValue.split('/').slice(1).join('/') || selectedValue
			: placeholder;
		return { label: fallback, brand: null };
	});
	const label = $derived(selected.label);

	const capabilityGroups = $derived.by(() => {
		if (!capability) return groups;
		return groups
			.map((group) => ({
				provider: group.provider,
				models: group.models.filter((model) => model.capabilities.includes(capability))
			}))
			.filter((group) => group.models.length > 0);
	});

	const capabilityMappings = $derived.by(() => {
		if (!capability) return mappings;
		return mappings.filter((m) => m.capabilities?.includes(capability));
	});

	const filteredGroups = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return capabilityGroups;
		return capabilityGroups
			.map((group) => ({
				provider: group.provider,
				models: group.models.filter(
					(model) =>
						model.displayName.toLowerCase().includes(q) ||
						model.modelId.toLowerCase().includes(q) ||
						group.provider.name.toLowerCase().includes(q)
				)
			}))
			.filter((group) => group.models.length > 0);
	});

	const filteredMappings = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return capabilityMappings;
		return capabilityMappings.filter((m) => m.name.toLowerCase().includes(q));
	});

	const optionGroups = $derived(
		filteredGroups.map((group) => ({
			provider: group.provider,
			options: group.models.map((model) => modelOption(model, group.provider))
		}))
	);
	const allMappingOptions = $derived(filteredMappings.map(mappingOption));
	const allOptions = $derived([...allMappingOptions, ...optionGroups.flatMap((g) => g.options)]);

	// Favourites are listed once, at the top, in the order they were starred.
	const favoriteOptions = $derived.by(() => {
		if (!favorites) return [];
		const byValue = new Map(allOptions.map((o) => [o.value, o]));
		return favorites.refs.flatMap((ref) => byValue.get(ref) ?? []);
	});
	const isFavorite = (v: string) => favorites?.has(v) ?? false;

	const mappingOptions = $derived(allMappingOptions.filter((o) => !isFavorite(o.value)));
	const providerGroups = $derived(
		optionGroups
			.map((group) => ({
				provider: group.provider,
				options: group.options.filter((o) => !isFavorite(o.value))
			}))
			.filter((group) => group.options.length > 0)
	);

	const isEmpty = $derived(allOptions.length === 0);

	const showNone = $derived.by(() => {
		if (noneValue === undefined) return false;
		const q = query.trim().toLowerCase();
		return q === '' || noneLabel.toLowerCase().includes(q);
	});

	function onSelect(v: string) {
		selectedValue = v;
		value = v;
		query = '';
		onselect(v);
	}
</script>

{#snippet item(option: Option, showSource = false)}
	<ModelOptionItem
		value={option.value}
		name={option.name}
		brand={option.brand}
		source={showSource ? option.source : undefined}
	/>
{/snippet}

<Select.Root type="single" bind:value={selectedValue as never} onValueChange={onSelect}>
	<Select.Trigger class={className} {disabled} title={label}>
		<span class="flex min-w-0 flex-1 items-center gap-1.5 text-left">
			{#if selected.brand}
				<ProviderIcon brand={selected.brand} class="size-3.5 shrink-0" />
			{/if}
			<span class="truncate">{label}</span>
		</span>
	</Select.Trigger>
	<Select.Content
		class="h-[min(24rem,var(--bits-select-content-available-height))] w-(--bits-select-anchor-width) min-w-72"
	>
		<div class="sticky top-0 z-10 border-b bg-popover/95 p-1 backdrop-blur-sm">
			<div class="relative">
				<SearchIcon
					class="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					type="text"
					bind:value={query}
					placeholder="Search models…"
					class="h-8 w-full rounded-3xl border border-transparent bg-input/50 pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
					onclick={(e) => e.stopPropagation()}
					onkeydown={(e) => e.stopPropagation()}
				/>
			</div>
		</div>
		{#if showNone}
			<Select.Item value={noneValue ?? ''}>{noneLabel}</Select.Item>
		{/if}
		<ModelFavoritesGroup count={favoriteOptions.length} searching={query.trim() !== ''}>
			{#each favoriteOptions as option (option.value)}
				{@render item(option, true)}
			{/each}
		</ModelFavoritesGroup>
		{#if mappingOptions.length > 0}
			<Select.Group>
				<Select.Label>Mapped models</Select.Label>
				{#each mappingOptions as option (option.value)}
					{@render item(option)}
				{/each}
			</Select.Group>
		{/if}
		{#each providerGroups as group (group.provider.id)}
			<Select.Group>
				{@const groupBrand = resolveProviderBrand(group.provider)}
				<Select.Label class="flex items-center gap-1.5">
					{#if groupBrand}<ProviderIcon brand={groupBrand} class="size-3 shrink-0" />{/if}
					{group.provider.name}
				</Select.Label>
				{#each group.options as option (option.value)}
					{@render item(option)}
				{/each}
			</Select.Group>
		{/each}
		{#if isEmpty && !showNone}
			<div class="px-3 py-6 text-center text-sm text-muted-foreground">No models found.</div>
		{/if}
	</Select.Content>
</Select.Root>
