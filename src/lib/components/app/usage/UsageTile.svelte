<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import AnimatedNumber, { type NumberFormatKind } from '../AnimatedNumber.svelte';
	import ProviderBillingBadge from './ProviderBillingBadge.svelte';
	import type { BillingType } from './usage.js';

	let {
		billing,
		label,
		value,
		format = 'usd',
		prefix,
		suffix,
		subtitle,
		caption,
		children
	}: {
		billing: BillingType;
		label: string;
		/** A number animates on change; a string (e.g. "Not priced") shows as-is; null is "—". */
		value: number | string | null;
		format?: NumberFormatKind;
		prefix?: string;
		suffix?: string;
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
			<AnimatedNumber
				class="text-3xl font-semibold tabular-nums"
				{value}
				{format}
				{prefix}
				{suffix}
			/>
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
