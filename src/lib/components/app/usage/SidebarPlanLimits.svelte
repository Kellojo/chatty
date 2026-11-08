<script lang="ts">
	// Compact plan-limit meter for the sidebar's Usage item (rendered inside its link).
	import { onMount } from 'svelte';
	import { providerLabel } from '$lib/coding-environments.js';
	import { resolveBrand } from '$lib/provider-brand.js';
	import ProviderIcon from '../ProviderIcon.svelte';
	import { onServerEventResync } from '$lib/state/events.svelte.js';
	import {
		constrainingWindow,
		distinctUsageAccounts,
		isExpiredWindow,
		remainingPercent,
		resetLabel,
		type UsageAccount
	} from './usage.js';

	// Limits only change when an environment syncs (every 15 min server-side).
	const REFRESH_MS = 5 * 60_000;

	let accounts = $state<UsageAccount[]>([]);
	let now = $state(Date.now());

	async function refresh() {
		try {
			const res = await fetch('/api/coding-environments/limits');
			if (!res.ok) return;
			const data = (await res.json()) as { accounts: UsageAccount[] };
			accounts = distinctUsageAccounts(data.accounts);
		} catch {
			// Keep the last known limits.
		}
	}

	onMount(() => {
		void refresh();
		const tick = setInterval(() => (now = Date.now()), 60_000);
		const poll = setInterval(() => {
			if (!document.hidden) void refresh();
		}, REFRESH_MS);
		const offResync = onServerEventResync(() => void refresh());
		return () => {
			clearInterval(tick);
			clearInterval(poll);
			offResync();
		};
	});

	const rows = $derived(
		accounts.flatMap((account) => {
			const window = constrainingWindow(account, now);
			if (!window) return [];
			const sameProvider = accounts.filter((a) => a.provider === account.provider).length > 1;
			const name = providerLabel(account.provider);
			const left = remainingPercent(window);
			const stale = isExpiredWindow(window, now);
			const reset = resetLabel(window.resetsAt, now);
			const who = account.accountEmail ?? account.accountLabel;
			return [
				{
					key: account.key,
					brand: resolveBrand(account.provider, account.accountLabel),
					label: sameProvider ? `${name} · ${who}` : name,
					left,
					level: stale ? 'stale' : left <= 5 ? 'critical' : left <= 20 ? 'warning' : 'ok',
					title: [
						`${name}${account.accountPlan ? ` ${account.accountPlan}` : ''} (${who})`,
						`${window.windowLabel}: ${left}% left${reset ? ` · ${reset}` : ''}`,
						account.environmentName ? `via ${account.environmentName}` : ''
					]
						.filter(Boolean)
						.join('\n')
				}
			];
		})
	);

	// One meter: the account closest to its cap (stale ones only when all are stale).
	const tightest = $derived(
		[...rows].sort(
			(a, b) => Number(a.level === 'stale') - Number(b.level === 'stale') || a.left - b.left
		)[0]
	);
	// The tooltip lists every account.
	const title = $derived(rows.map((r) => r.title).join('\n\n'));
</script>

{#if tightest}
	<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums" {title}>
		{#if tightest.brand}
			<ProviderIcon brand={tightest.brand} class="size-3 shrink-0" />
		{/if}
		<span
			class="h-1 w-8 overflow-hidden rounded-full bg-foreground/10"
			role="progressbar"
			aria-label="{tightest.label} plan: remaining"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={tightest.left}
			aria-valuetext="{tightest.left}% left"
		>
			<span
				class="block h-full rounded-full {tightest.level === 'critical'
					? 'bg-destructive'
					: tightest.level === 'warning'
						? 'bg-amber-500'
						: tightest.level === 'stale'
							? 'bg-muted-foreground/30'
							: 'bg-muted-foreground'}"
				style:width="{Math.min(100, Math.max(tightest.left, tightest.left > 0 ? 2 : 0))}%"
			></span>
		</span>
		<span
			class={tightest.level === 'critical'
				? 'text-destructive'
				: tightest.level === 'warning'
					? 'text-amber-600 dark:text-amber-400'
					: tightest.level === 'stale'
						? 'line-through decoration-muted-foreground/60'
						: ''}>{tightest.left}%</span
		>
	</span>
{/if}
