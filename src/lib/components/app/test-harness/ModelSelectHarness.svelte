<script lang="ts">
	// Test-only: provides the favourites context the app layout normally sets.
	import ModelSelect from '../ModelSelect.svelte';
	import { FavoriteModels, setFavoriteModels } from '$lib/state/favorite-models.svelte.js';
	import type { ModelsByProvider } from '$lib/types.js';

	let {
		groups,
		favorites,
		value
	}: { groups: ModelsByProvider[]; favorites: string[]; value: string } = $props();

	// svelte-ignore state_referenced_locally
	setFavoriteModels(new FavoriteModels(favorites));
</script>

<ModelSelect {groups} {value} onselect={() => {}} />
