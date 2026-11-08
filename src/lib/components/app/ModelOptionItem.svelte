<script lang="ts">
	import type { Snippet } from 'svelte';
	import StarIcon from '@lucide/svelte/icons/star';
	import BoxIcon from '@lucide/svelte/icons/box';
	import * as Select from '$lib/components/ui/select/index.js';
	import ProviderIcon from './ProviderIcon.svelte';
	import { getFavoriteModels } from '$lib/state/favorite-models.svelte.js';
	import type { Brand } from '$lib/provider-brand.js';

	/**
	 * One model row in a model picker: maker icon, name, optional source and a
	 * star that adds it to (or removes it from) the user's favourites.
	 */
	let {
		value,
		name,
		brand,
		source,
		favoriteKey = value,
		lockedFavorite,
		badges
	}: {
		value: string;
		name: string;
		brand: Brand | null;
		/** Shown after the name, e.g. the provider when the row sits in Favorites. */
		source?: string;
		/** Key in the favourites list, when it differs from the select value. */
		favoriteKey?: string;
		/** Starred elsewhere (e.g. in T3) and not editable here; the tooltip says why. */
		lockedFavorite?: string;
		badges?: Snippet;
	} = $props();

	const favorites = getFavoriteModels();
	const own = $derived(favorites?.has(favoriteKey) ?? false);
	const starred = $derived(own || !!lockedFavorite);
	const locked = $derived(!own && !!lockedFavorite);
</script>

<Select.Item {value} label={name} class="group/model">
	{#if brand}
		<ProviderIcon {brand} class="size-3.5 shrink-0" />
	{:else}
		<!-- Same generic glyph as the picker trigger, e.g. for mappings like "auto". -->
		<BoxIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
	{/if}
	<span class="truncate">{name}</span>
	{#if source}
		<span class="shrink-0 truncate text-xs font-normal text-muted-foreground">{source}</span>
	{/if}
	{@render badges?.()}
	{#if locked}
		<span class="ml-auto flex size-5 shrink-0 items-center justify-center" title={lockedFavorite}>
			<StarIcon class="size-3.5 fill-amber-400 text-amber-400" aria-label={lockedFavorite} />
		</span>
	{:else if favorites}
		<!-- Keep pointer events off the item, or bits-ui selects it. -->
		<button
			type="button"
			tabindex={-1}
			class={[
				'ml-auto flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-amber-400',
				!starred &&
					'opacity-0 group-hover/model:opacity-100 group-data-highlighted/model:opacity-100'
			]}
			aria-label={starred ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
			aria-pressed={starred}
			title={starred ? 'Remove from favorites' : 'Add to favorites'}
			onpointerdown={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
			onpointerup={(e) => e.stopPropagation()}
			onclick={(e) => {
				e.stopPropagation();
				favorites.toggle(favoriteKey);
			}}
		>
			<StarIcon class={['size-3.5', starred && 'fill-amber-400 text-amber-400']} />
		</button>
	{/if}
</Select.Item>
