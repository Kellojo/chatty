<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatTimeAgo } from '$lib/datetime.js';
	import type { CodingEnvironment } from '$lib/coding-environments.js';
	import { syncEnvironment } from './usage.js';

	let { environments, now }: { environments: CodingEnvironment[]; now: number } = $props();

	let syncing = $state(false);
	const enabled = $derived(environments.filter((e) => e.enabled));

	function chipState(env: CodingEnvironment): { dot: string; text: string; error: boolean } {
		if (!env.enabled) return { dot: 'bg-muted-foreground/40', text: 'disabled', error: false };
		if (env.status === 'error') return { dot: 'bg-destructive', text: 'unreachable', error: true };
		if (env.lastSyncedAt)
			return {
				dot: env.status === 'online' ? 'bg-emerald-500' : 'bg-muted-foreground/40',
				text: `synced ${formatTimeAgo(env.lastSyncedAt, now)}`,
				error: false
			};
		return { dot: 'bg-muted-foreground/40', text: 'never synced', error: false };
	}

	async function syncAll() {
		syncing = true;
		try {
			const results = await Promise.all(enabled.map((e) => syncEnvironment(e.id)));
			const failed = results.filter((r) => !r || r.status === 'error').length;
			if (failed > 0)
				toast.error(`${failed} environment${failed === 1 ? '' : 's'} could not be synced`);
			await invalidateAll();
		} finally {
			syncing = false;
		}
	}
</script>

<div
	class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground"
	aria-label="Data sources"
	role="group"
>
	<span class="font-medium text-foreground">Data sources</span>
	<span class="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5">
		<span class="size-1.5 rounded-full bg-emerald-500" aria-hidden="true"></span>
		Chatty providers · live
	</span>
	{#each environments as env (env.id)}
		{@const s = chipState(env)}
		<span
			class="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 {s.error
				? 'border-destructive/40 text-destructive'
				: 'border-border/60'}"
			title={s.error ? (env.lastError ?? 'Unreachable') : (env.environmentLabel ?? env.baseUrl)}
		>
			<span class="size-1.5 shrink-0 rounded-full {s.dot}" aria-hidden="true"></span>
			<span class="truncate">{env.name} · {s.text}</span>
		</span>
	{:else}
		<span class="inline-flex items-center gap-1.5 rounded-full border border-dashed px-2 py-0.5">
			<span class="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden="true"></span>
			No subscriptions connected
		</span>
	{/each}
	<!-- With nothing connected, the Subscriptions tile carries the one connect CTA. -->
	{#if environments.length > 0}
		<span class="ml-auto flex items-center gap-1">
			{#if enabled.length > 0}
				<Button
					variant="ghost"
					size="icon"
					class="size-10 md:size-7"
					onclick={syncAll}
					disabled={syncing}
					aria-label="Sync all coding environments"
					title="Sync all coding environments"
				>
					{#if syncing}
						<Loader2Icon class="size-3.5 animate-spin" />
					{:else}
						<RefreshCwIcon class="size-3.5" />
					{/if}
				</Button>
			{/if}
			<a
				href={resolve('/settings/environments')}
				class="inline-flex h-10 items-center rounded-md px-2 font-medium text-foreground underline-offset-4 hover:underline md:h-7"
			>
				Manage
			</a>
		</span>
	{/if}
</div>
