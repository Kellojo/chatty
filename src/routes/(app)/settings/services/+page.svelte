<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import ArtificialAnalysisDialog from '$lib/components/app/settings/services/ArtificialAnalysisDialog.svelte';
	import { formatAge } from '$lib/formats.js';
	import {
		clockTime,
		createClock
	} from '$lib/components/app/settings/artificial-analysis.svelte.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const aa = $derived(data.artificialAnalysis);
	const aaConnected = $derived(aa.aa.key.source !== null);
	const aaFailed = $derived(aaConnected && aa.aa.status.lastError !== null);

	/** Every service on this page; a new one adds its id here, a row and a dialog below. */
	const SERVICE_IDS = ['artificial-analysis'] as const;
	type ServiceId = (typeof SERVICE_IDS)[number];
	const isServiceId = (id: string | null): id is ServiceId =>
		(SERVICE_IDS as readonly (string | null)[]).includes(id);

	/** The service whose settings dialog is open. */
	let configuring = $state<ServiceId | null>(null);
	/** Two-way binding for one service's dialog. */
	const dialogOpen = (id: ServiceId) => ({
		get: () => configuring === id,
		set: (open: boolean) => (configuring = open ? id : null)
	});
	const aaDialog = dialogOpen('artificial-analysis');

	const clock = createClock();
	const retryAt = $derived(
		aa.aa.status.retryAfter && aa.aa.status.retryAfter > clock.now ? aa.aa.status.retryAfter : null
	);

	// Links like the Models page's "Manage" open a service's dialog directly.
	onMount(() => {
		const service = page.url.searchParams.get('configure');
		if (!isServiceId(service)) return;
		configuring = service;
		void goto(resolve('/settings/services'), { replaceState: true, noScroll: true });
	});
</script>

<svelte:head><title>Services · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="Services"
	description="Third-party services Chatty pulls data from. Keys are stored encrypted and only used on the server."
/>

<SettingsSection
	title="Model data"
	description="Extra information about the models you use, shown on the Models page."
	flush
>
	<ul class="divide-y divide-border/60 border-t border-border/60">
		<SettingsListItem title="Artificial Analysis">
			{#snippet leading()}<GaugeIcon class="size-4" />{/snippet}
			{#snippet badges()}
				{#if aaConnected}
					<Badge variant="secondary" class="text-success-foreground">Connected</Badge>
				{/if}
			{/snippet}
			{#snippet meta()}
				{#if aaFailed}
					<!-- The reason, short enough for one line; the dialog has the full message. -->
					<span class="flex min-w-0 items-center gap-1 text-destructive"
						><CircleAlertIcon class="size-3.5 shrink-0" /><span class="shrink-0"
							>Refresh failed{#if retryAt}, retry at {clockTime(retryAt)}{/if}</span
						><span class="ml-0.5 truncate">· {aa.aa.status.lastError?.replace(/\.$/, '')}</span
						></span
					>
				{:else if aaConnected && aa.aa.status.fetchedAt}
					{aa.matched} of {aa.total} models scored · updated {formatAge(
						clock.now - aa.aa.status.fetchedAt
					)} ago
				{:else}
					Intelligence Index scores to rank and sort your models
				{/if}
			{/snippet}
			{#snippet trailing()}
				<Button
					size="sm"
					variant={aaConnected ? 'outline' : 'default'}
					onclick={() => (configuring = 'artificial-analysis')}
				>
					{aaConnected ? 'Configure' : 'Connect'}
				</Button>
			{/snippet}
		</SettingsListItem>
	</ul>
</SettingsSection>

<ArtificialAnalysisDialog
	bind:open={aaDialog.get, aaDialog.set}
	aa={aa.aa}
	matched={aa.matched}
	total={aa.total}
/>
