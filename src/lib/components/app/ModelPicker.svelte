<script lang="ts">
	import { onMount } from 'svelte';
	import ModelSelect from './ModelSelect.svelte';
	import { registerModelPicker, shortcutLabel } from '$lib/state/shortcuts.js';
	import type { ModelMapping, ModelsByProvider } from '$lib/types.js';

	let {
		groups,
		mappings = [],
		value,
		onselect,
		disabled = false,
		placeholder = 'Select model',
		align = 'start',
		class: className = 'w-40 min-w-0 shrink sm:w-64'
	}: {
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		value: string;
		onselect: (value: string) => void;
		disabled?: boolean;
		placeholder?: string;
		align?: 'start' | 'end';
		class?: string;
	} = $props();

	// The chat's picker (topbar or new-chat page): the model shortcut opens it. Focus
	// goes to the trigger first, as with a click, so the arrow keys move through the list.
	let open = $state(false);
	let trigger = $state<HTMLElement | null>(null);
	onMount(() =>
		registerModelPicker(() => {
			if (disabled) return false;
			trigger?.focus();
			open = true;
			return true;
		})
	);
</script>

<ModelSelect
	{groups}
	{mappings}
	{value}
	bind:open
	bind:trigger
	shortcut={shortcutLabel('model-picker')}
	{onselect}
	{disabled}
	{placeholder}
	{align}
	class={className}
/>
