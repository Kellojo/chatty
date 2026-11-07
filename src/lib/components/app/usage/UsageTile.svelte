<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import ProviderBillingBadge from './ProviderBillingBadge.svelte';
	import type { BillingType } from './usage.js';

	let {
		billing,
		label,
		value,
		subtitle,
		caption,
		children
	}: {
		billing: BillingType;
		label: string;
		value: string;
		subtitle: string;
		/** Explains the headline value itself (e.g. why it is "—"), right under it. */
		caption?: string;
		/** Supporting detail under the headline number. */
		children?: Snippet;
	} = $props();
</script>

<Card.Root class="rounded-2xl border-border/40">
	<Card.Content class="flex h-full flex-col gap-2">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<span class="text-sm text-muted-foreground">{label}</span>
			<ProviderBillingBadge {billing} />
		</div>
		<div class="flex flex-col">
			<span class="text-3xl font-semibold tabular-nums">{value}</span>
			{#if caption}
				<span class="text-sm font-medium text-muted-foreground">{caption}</span>
			{/if}
		</div>
		<span class="text-xs text-muted-foreground">{subtitle}</span>
		{#if children}
			<div class="mt-auto flex flex-col gap-2 pt-1">{@render children()}</div>
		{/if}
	</Card.Content>
</Card.Root>
