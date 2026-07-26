<script lang="ts">
	import { untrack } from 'svelte';
	import SearchIcon from '@lucide/svelte/icons/search';
	import * as Select from '$lib/components/ui/select/index.js';
	import { mappingModelRef, encodeModelRef } from '$lib/model-ref.js';
	import type { ModelMapping, ModelsByProvider } from '$lib/types.js';

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

	let selectedValue = $state(untrack(() => value));
	let query = $state('');

	$effect(() => {
		if (selectedValue !== value) {
			selectedValue = value;
		}
	});

	const label = $derived.by(() => {
		for (const mapping of mappings) {
			if (encodeModelRef(mappingModelRef(mapping)) === selectedValue) {
				return `${mapping.name} (mapping)`;
			}
		}
		for (const group of groups) {
			for (const model of group.models) {
				if (`${model.providerId}/${model.modelId}` === selectedValue) {
					return `${model.displayName} (${group.provider.name})`;
				}
			}
		}
		if (selectedValue) return selectedValue.split('/').slice(1).join('/') || selectedValue;
		return placeholder;
	});

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

	const isEmpty = $derived(filteredGroups.length === 0 && filteredMappings.length === 0);

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

<Select.Root type="single" bind:value={selectedValue as never} onValueChange={onSelect}>
	<Select.Trigger class={className} {disabled} title={label}>
		<span class="min-w-0 flex-1 truncate text-left">{label}</span>
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
		{#if filteredMappings.length > 0}
			<Select.Group>
				<Select.Label>Mapped models</Select.Label>
				{#each filteredMappings as mapping (mapping.id)}
					<Select.Item value={encodeModelRef(mappingModelRef(mapping))}>
						{mapping.name}
					</Select.Item>
				{/each}
			</Select.Group>
		{/if}
		{#each filteredGroups as group (group.provider.id)}
			<Select.Group>
				<Select.Label>{group.provider.name}</Select.Label>
				{#each group.models as model (model.id)}
					<Select.Item value={`${model.providerId}/${model.modelId}`}>
						{model.displayName}
					</Select.Item>
				{/each}
			</Select.Group>
		{/each}
		{#if isEmpty && !showNone}
			<div class="px-3 py-6 text-center text-sm text-muted-foreground">No models found.</div>
		{/if}
	</Select.Content>
</Select.Root>
