<script lang="ts">
	import { untrack } from 'svelte';
	import BoxIcon from '@lucide/svelte/icons/box';
	import LockIcon from '@lucide/svelte/icons/lock';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
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
	import { mappingTrusted, trustedProviderIds } from '$lib/private-data.js';
	import type { ModelMapping, PickerModelGroup } from '$lib/types.js';

	let {
		groups,
		mappings = [],
		value = $bindable(''),
		open = $bindable(false),
		trigger = $bindable(null),
		shortcut,
		onselect,
		disabled = false,
		placeholder = 'Select model',
		noneValue,
		noneLabel = 'Not set',
		capability,
		align = 'start',
		standalone = false,
		privateOnly = false,
		privateNote = 'Private chat: trusted models only',
		class: className = 'w-64'
	}: {
		groups: PickerModelGroup[];
		mappings?: ModelMapping[];
		value: string;
		/** Whether the list is showing. */
		open?: boolean;
		/** The trigger button, which holds focus (and so the arrow keys) while the list is open. */
		trigger?: HTMLElement | null;
		/** The keys that open it, for the tooltip. */
		shortcut?: string;
		onselect: (value: string) => void;
		disabled?: boolean;
		placeholder?: string;
		noneValue?: string;
		noneLabel?: string;
		capability?: string;
		/** Which trigger edge the list lines up with; `end` for pickers at the right of a bar. */
		align?: 'start' | 'end';
		/** No visible label beside it (the chat pickers): name it "Model: …" for screen readers. */
		standalone?: boolean;
		/**
		 * For a private chat or agent: only models on providers trusted with private
		 * data (and mappings whose every target is) can be picked; the rest are greyed out.
		 */
		privateOnly?: boolean;
		/** The note above the list while `privateOnly` is on. */
		privateNote?: string;
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
		/** May run a private chat (its provider, or every mapping target's, is trusted). */
		trusted: boolean;
		/** Why an untrusted option can't run a private chat, shown on its greyed row. */
		untrustedReason?: string;
	}

	const trustedIds = $derived(trustedProviderIds(groups));

	const mappingOption = (mapping: ModelMapping): Option => ({
		value: encodeModelRef(mappingModelRef(mapping)),
		name: mapping.name,
		source: 'Mapping',
		brand:
			resolveBrand(mapping.name) ??
			(mapping.targets[0] ? resolveModelBrand(mapping.targets[0]) : null),
		trusted: mappingTrusted(mapping, trustedIds),
		// A mapping that may fall back to an untrusted provider counts as untrusted.
		untrustedReason: mapping.targets.some((t) => trustedIds.has(t.providerId))
			? 'Can fall back to an untrusted provider'
			: 'Not trusted with private data'
	});

	const modelOption = (
		model: PickerModelGroup['models'][number],
		provider: PickerModelGroup['provider']
	): Option => ({
		value: `${model.providerId}/${model.modelId}`,
		name: model.displayName,
		source: provider.name,
		brand: resolveModelBrand(model, provider),
		trusted: trustedIds.has(provider.id)
	});

	const selected = $derived.by(() => {
		for (const mapping of mappings) {
			const option = mappingOption(mapping);
			if (option.value === selectedValue) {
				return { label: `${option.name} · Mapped model`, mapping: true, ...option };
			}
		}
		for (const { provider, models } of groups) {
			for (const model of models) {
				const option = modelOption(model, provider);
				if (option.value === selectedValue) {
					return { label: `${option.name} · ${provider.name}`, ...option };
				}
			}
		}
		const fallback = selectedValue
			? selectedValue.split('/').slice(1).join('/') || selectedValue
			: placeholder;
		return { label: fallback, brand: null };
	});
	/** The chat is private but its model isn't trusted: its next turn would be refused. */
	const selectedUntrusted = $derived(
		privateOnly && !!selectedValue && !('trusted' in selected && selected.trusted)
	);
	const label = $derived(
		selectedUntrusted ? `${selected.label} (not trusted with private data)` : selected.label
	);

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
		disabled={privateOnly && !option.trusted}
		disabledReason={option.untrustedReason ?? 'Not trusted with private data'}
		disabledShort={option.untrustedReason?.startsWith('Can fall back') ? 'Mixed' : 'Untrusted'}
	/>
{/snippet}

<Select.Root type="single" bind:open bind:value={selectedValue as never} onValueChange={onSelect}>
	<Select.Trigger
		bind:ref={trigger}
		class={className}
		{disabled}
		aria-label={standalone ? `Model: ${label}` : undefined}
		title={shortcut ? `${label} (${shortcut})` : label}
	>
		<span class="flex min-w-0 flex-1 items-center gap-1.5 text-left">
			<!-- data-model-icon / data-model-source let compact callers (phone topbar and composer)
			     drop the icon and the " · Provider" suffix and keep just the model name.
			     data-model-icon is "brand" for a provider logo, "generic" for mappings like "auto".
			     Mappings have no source suffix: "Mapping" says nothing the box icon doesn't. -->
			<span data-model-icon={selected.brand ? 'brand' : 'generic'} class="contents">
				{#if selected.brand}
					<ProviderIcon brand={selected.brand} class="size-3.5 shrink-0" />
				{:else if selectedValue}
					<BoxIcon class="size-3.5 shrink-0 text-muted-foreground" />
				{/if}
			</span>
			{#if selectedUntrusted}
				<TriangleAlertIcon
					class="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
					aria-hidden="true"
				/>
			{/if}
			{#if 'name' in selected}
				<span class="truncate"
					>{selected.name}{#if !('mapping' in selected)}<span data-model-source
							>&nbsp;· {selected.source}</span
						>{/if}</span
				>
			{:else}
				<span class="truncate">{label}</span>
			{/if}
		</span>
	</Select.Trigger>
	<Select.Content
		{align}
		collisionPadding={8}
		class="h-[min(24rem,var(--bits-select-content-available-height))] w-(--bits-select-anchor-width) max-w-[calc(100vw-1rem)] min-w-72"
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
			{#if privateOnly}
				<p
					class="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground"
					data-private-note
				>
					<LockIcon class="size-3 shrink-0" aria-hidden="true" />
					{privateNote}
				</p>
			{/if}
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
