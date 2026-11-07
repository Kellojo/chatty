<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import EnvironmentStatusBadge from '$lib/components/app/EnvironmentStatusBadge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { formatTimeAgo } from '$lib/datetime.js';
	import type { CodingEnvironment } from '$lib/coding-environments.js';
	import { syncEnvironment } from './usage.js';

	let { environment: env, now }: { environment: CodingEnvironment; now: number } = $props();

	let syncing = $state(false);

	async function sync() {
		syncing = true;
		try {
			const updated = await syncEnvironment(env.id);
			if (!updated) toast.error(`${env.name}: sync failed`);
			else if (updated.status === 'error')
				toast.error(`${env.name}: ${updated.lastError ?? 'unreachable'}`);
			await invalidateAll();
		} finally {
			syncing = false;
		}
	}
</script>

<Card.Root class="rounded-2xl border-border/40">
	<Card.Content class="flex flex-col gap-2">
		<div class="flex items-start justify-between gap-2">
			<div class="flex min-w-0 flex-col">
				<span class="truncate font-medium" title={env.name}>{env.name}</span>
				<span class="truncate text-xs text-muted-foreground" title={env.baseUrl}>
					{env.environmentLabel ?? env.baseUrl}
				</span>
			</div>
			<EnvironmentStatusBadge environment={env} />
		</div>
		<div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
			<span>
				{env.serverVersion ? `T3 Code ${env.serverVersion} · ` : ''}
				{env.lastSyncedAt ? `synced ${formatTimeAgo(env.lastSyncedAt, now)}` : 'never synced'}
			</span>
			<Button
				variant="ghost"
				size="sm"
				class="h-7 px-2"
				disabled={!env.enabled || syncing}
				onclick={sync}
				aria-label={`Sync ${env.name}`}
				title={`Sync ${env.name}`}
			>
				{#if syncing}
					<Loader2Icon class="size-3.5 animate-spin" />
				{:else}
					<RefreshCwIcon class="size-3.5" />
				{/if}
			</Button>
		</div>
		{#if env.enabled && env.status === 'error' && env.lastError}
			<p class="text-xs wrap-break-word text-destructive">{env.lastError}</p>
		{/if}
	</Card.Content>
</Card.Root>
