<script lang="ts">
	import { BRAND_ICONS } from '$lib/brand-icons.js';
	import type { Brand } from '$lib/provider-brand.js';

	let {
		brand,
		class: className = 'size-4',
		decorative = false
	}: {
		brand: Brand;
		class?: string;
		/** Next to a text label that already names the brand: hidden from screen readers. */
		decorative?: boolean;
	} = $props();

	const icon = $derived(BRAND_ICONS[brand]);
	/** Per-path colours, for the few marks that keep theirs. */
	const fills = $derived<readonly string[] | undefined>('fills' in icon ? icon.fills : undefined);
</script>

<svg
	class={[className, brand === 'claude' && 'text-[#D97757]']}
	viewBox="0 0 24 24"
	fill="currentColor"
	fill-rule="evenodd"
	role={decorative ? undefined : 'img'}
	aria-label={decorative ? undefined : icon.label}
	aria-hidden={decorative ? 'true' : undefined}
>
	{#each icon.paths as d, i (i)}
		<path {d} fill={fills?.[i]} />
	{/each}
</svg>
