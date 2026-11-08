<script lang="ts">
	import ModelSelect from './ModelSelect.svelte';
	import type { ModelMapping, ModelsByProvider } from '$lib/types.js';

	let {
		groups,
		mappings = [],
		value,
		onselect,
		disabled = false,
		placeholder = 'Select model',
		class: className = 'w-40 min-w-0 shrink sm:w-64'
	}: {
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		value: string;
		onselect: (value: string) => void;
		disabled?: boolean;
		placeholder?: string;
		class?: string;
	} = $props();
</script>

<ModelSelect {groups} {mappings} {value} {onselect} {disabled} {placeholder} class={className} />
