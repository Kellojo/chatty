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

	let {
		environment: env,
		now,
		compact = false
	}: {
		environment: CodingEnvironment;
		now: number;
		/** One-line row (for a single environment) instead of a card. */
		compact?: boolean;
	} = $props();

	let syncing = $state(false);
	// Skip the server's own label when it just repeats the name.
	const subtitle = $derived(
		(env.environmentLabel ?? env.baseUrl) !== env.name
			? (env.environmentLabel ?? env.baseUrl)
			: null
	);
	const meta = $derived(
		`${env.serverVersion ? `T3 Code ${env.serverVersion} · ` : ''}${
			env.lastSyncedAt ? `synced ${formatTimeAgo(env.lastSyncedAt, now)}` : 'never synced'
		}`
	);

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

{#snippet syncButton()}
	<Button
		variant="ghost"
		size="icon"
		class="size-7"
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
{/snippet}

<Card.Root class="rounded-2xl border-border/40 {compact ? 'py-3' : ''}">
	<Card.Content class="flex flex-col gap-2">
		{#if compact}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span class="truncate font-medium" title={subtitle ?? env.baseUrl}>{env.name}</span>
				<EnvironmentStatusBadge environment={env} />
				<span class="text-xs text-muted-foreground">{meta}</span>
				<span class="ml-auto">{@render syncButton()}</span>
			</div>
		{:else}
			<div class="flex items-start justify-between gap-2">
				<div class="flex min-w-0 flex-col">
					<span class="truncate font-medium" title={env.name}>{env.name}</span>
					{#if subtitle}
						<span class="truncate text-xs text-muted-foreground" title={env.baseUrl}>
							{subtitle}
						</span>
					{/if}
				</div>
				<!-- Status and its sync action share the header row. -->
				<div class="flex shrink-0 items-center gap-1">
					<EnvironmentStatusBadge environment={env} />
					{@render syncButton()}
				</div>
			</div>
			<span class="text-xs text-muted-foreground">{meta}</span>
		{/if}
		{#if env.enabled && env.status === 'error' && env.lastError}
			<p class="text-xs wrap-break-word text-destructive">{env.lastError}</p>
		{/if}
	</Card.Content>
</Card.Root>
