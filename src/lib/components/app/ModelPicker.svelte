<script lang="ts">
	import ModelSelect from './ModelSelect.svelte';
	import type { ModelMapping, ModelsByProvider } from '$lib/types.js';

	let {
		groups,
		mappings = [],
		value,
		onselect,
		disabled = false,
		placeholder = 'Select model'
	}: {
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		value: string;
		onselect: (value: string) => void;
		disabled?: boolean;
		placeholder?: string;
	} = $props();
</script>

<ModelSelect
	{groups}
	{mappings}
	{value}
	{onselect}
	{disabled}
	{placeholder}
	class="w-40 sm:w-64"
/>
