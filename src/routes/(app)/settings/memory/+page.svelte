<script lang="ts">
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button/index.js';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isAdmin = $derived(data.user.role === 'admin');

	let extractBusy = $state(false);
	let reindexBusy = $state(false);

	async function extractNow() {
		if (extractBusy) return;
		extractBusy = true;
		try {
			const res = await fetch('/api/memory/extract', { method: 'POST' });
			const body = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
			toast.success('Extraction started');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to start extraction');
		} finally {
			extractBusy = false;
		}
	}

	async function reindex() {
		if (reindexBusy) return;
		reindexBusy = true;
		try {
			const res = await fetch('/api/memory/reindex', { method: 'POST' });
			const body = (await res.json().catch(() => null)) as {
				indexed?: number;
				message?: string;
			} | null;
			if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
			toast.success(`Search index rebuilt (${body?.indexed ?? 0} concepts)`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to rebuild index');
		} finally {
			reindexBusy = false;
		}
	}
</script>

<svelte:head><title>Memory · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="Memory"
	description="Long-term memory the assistant builds from your conversations."
>
	{#snippet actions()}
		<Button variant="outline" href={resolve('/memory')}>
			Browse memory <ArrowRightIcon class="size-4" />
		</Button>
	{/snippet}
</SettingsHeader>

<SettingsSection title="Extraction" description="Turns past chats into memory concepts.">
	<SettingsRow
		label="Extract memory"
		description="Runs automatically after every 5th new chat and distills recent conversations into memory concepts. Run it now to catch up right away."
		stack
	>
		<Button variant="outline" class="w-full sm:w-auto" disabled={extractBusy} onclick={extractNow}>
			{#if extractBusy}
				<LoaderCircleIcon class="size-4 animate-spin" />
				Starting…
			{:else}
				Extract now
			{/if}
		</Button>
	</SettingsRow>
</SettingsSection>

{#if isAdmin}
	<SettingsSection
		title="Search index"
		description="Full-text search over memory. Only admins can rebuild it."
	>
		<SettingsRow
			label="Full-text index"
			description="Covers all memory bundles. Rebuild it after changing memory files outside the app."
			stack
		>
			<Button variant="outline" class="w-full sm:w-auto" disabled={reindexBusy} onclick={reindex}>
				{#if reindexBusy}
					<LoaderCircleIcon class="size-4 animate-spin" />
					Rebuilding…
				{:else}
					Rebuild index
				{/if}
			</Button>
		</SettingsRow>
	</SettingsSection>
{/if}
