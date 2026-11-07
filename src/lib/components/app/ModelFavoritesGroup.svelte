<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import * as Select from '$lib/components/ui/select/index.js';
	import { getFavoriteModels } from '$lib/state/favorite-models.svelte.js';

	/**
	 * The Favorites section at the top of every model picker. It stays visible
	 * when empty (with a hint) so pickers look the same everywhere; only a
	 * search with no favourite matches hides it.
	 */
	let {
		count,
		searching = false,
		children
	}: { count: number; searching?: boolean; children: Snippet } = $props();

	const favorites = getFavoriteModels();

	/**
	 * On open, bits-ui scrolls the selected item into view once the list is
	 * positioned. When that item isn't a favourite (e.g. a mapping target being
	 * edited) the jump hides this section, so undo that first scroll.
	 */
	const keepInView: Attachment<HTMLElement> = (node) => {
		const scroller = node.closest<HTMLElement>('[data-select-viewport]');
		if (!scroller) return;
		const reset = () => (scroller.scrollTop = 0);
		scroller.addEventListener('scroll', reset, { once: true });
		const timer = setTimeout(() => scroller.removeEventListener('scroll', reset), 400);
		return () => {
			clearTimeout(timer);
			scroller.removeEventListener('scroll', reset);
		};
	};
</script>

{#if favorites && (count > 0 || !searching)}
	<Select.Group>
		<Select.Label>Favorites</Select.Label>
		{#if count > 0}
			<span class="hidden" aria-hidden="true" {@attach keepInView}></span>
			{@render children()}
		{:else}
			<div class="px-3 pb-2 text-xs text-muted-foreground">Star a model to pin it here.</div>
		{/if}
	</Select.Group>
{/if}
