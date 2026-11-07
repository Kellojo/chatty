<script lang="ts">
	import { BRAND_ICONS } from '$lib/brand-icons.js';
	import type { Brand } from '$lib/provider-brand.js';

	let { brand, class: className = 'size-4' }: { brand: Brand; class?: string } = $props();

	const icon = $derived(BRAND_ICONS[brand]);
</script>

<svg
	class={[className, brand === 'claude' && 'text-[#D97757]']}
	viewBox="0 0 24 24"
	fill="currentColor"
	fill-rule="evenodd"
	role="img"
	aria-label={icon.label}
>
	{#each icon.paths as d, i (i)}
		<path {d} />
	{/each}
</svg>
