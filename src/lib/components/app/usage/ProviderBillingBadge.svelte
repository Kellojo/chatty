<script lang="ts">
	import ReceiptIcon from '@lucide/svelte/icons/receipt';
	import RepeatIcon from '@lucide/svelte/icons/repeat';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { BillingType } from './usage.js';

	let { billing }: { billing: BillingType } = $props();
</script>

<!-- Billing type is told apart by icon and label, never by color alone. -->
{#if billing === 'payg'}
	<Badge
		variant="outline"
		class="gap-1 font-normal"
		title="Billed per token by a provider configured in Chatty"
	>
		<ReceiptIcon aria-hidden="true" />
		Pay-as-you-go
	</Badge>
{:else}
	<Badge
		variant="secondary"
		class="gap-1 font-normal"
		title="Included in a fixed-price plan; shown at API prices, not billed per token"
	>
		<RepeatIcon aria-hidden="true" />
		Subscription
	</Badge>
{/if}
