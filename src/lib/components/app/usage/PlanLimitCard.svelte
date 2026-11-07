<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { formatTimeAgo } from '$lib/datetime.js';
	import PlanLimitBar from './PlanLimitBar.svelte';
	import { subscriptionColor, type UsageAccount } from './usage.js';

	let { account, now }: { account: UsageAccount; now: number } = $props();
</script>

<Card.Root class="rounded-2xl border-border/40">
	<Card.Header class="pb-2">
		<Card.Title class="flex items-center gap-2 text-sm font-medium">
			<span
				class="size-2.5 shrink-0 rounded-full"
				style:background-color={subscriptionColor(account.provider)}
			></span>
			{account.accountLabel}
			{#if account.accountPlan}
				<Badge variant="outline" class="font-normal">{account.accountPlan}</Badge>
			{/if}
		</Card.Title>
		<Card.Description class="truncate">
			{#if account.accountEmail}
				<!-- Blurred so it doesn't leak in screenshots/screen shares; revealed on hover. -->
				<span
					class="cursor-default blur-[4px] transition-[filter] select-none hover:blur-none hover:select-auto"
					title="Hover to reveal">{account.accountEmail}</span
				>
				·
			{/if}
			{account.environmentName ? `${account.environmentName} · ` : ''}checked
			{formatTimeAgo(account.checkedAt, now)}
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		{#each account.windows as w (w.windowId)}
			<PlanLimitBar window={w} ariaLabel={`${account.accountLabel} ${w.windowLabel}`} {now} />
		{/each}
	</Card.Content>
</Card.Root>
