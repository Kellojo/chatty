<script lang="ts">
	// Test-only: provides the favourites context the app layout normally sets.
	import ModelSelect from '../ModelSelect.svelte';
	import { FavoriteModels, setFavoriteModels } from '$lib/state/favorite-models.svelte.js';
	import type { ModelMapping, ModelsByProvider } from '$lib/types.js';

	let {
		groups,
		favorites,
		value,
		mappings = [],
		privateOnly = false
	}: {
		groups: ModelsByProvider[];
		favorites: string[];
		value: string;
		mappings?: ModelMapping[];
		privateOnly?: boolean;
	} = $props();

	// svelte-ignore state_referenced_locally
	setFavoriteModels(new FavoriteModels(favorites));
</script>

<ModelSelect {groups} {mappings} {value} {privateOnly} onselect={() => {}} />
