<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isAdmin = $derived(data.user.role === 'admin');

	let extractBusy = $state(false);

	// Shown while a change is saving, until the refreshed settings agree.
	let strictPending = $state<boolean | null>(null);
	const strict = $derived(strictPending ?? data.settings.strictMemoryPrivacy);

	async function setStrict(value: boolean) {
		strictPending = value;
		const saved = await fetch('/api/memory/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ strictMemoryPrivacy: value })
		})
			.then((res) => res.ok)
			.catch(() => false);
		if (saved) await invalidateAll().catch(() => undefined);
		else toast.error("Couldn't change strict memory privacy. Try again.");
		if (strictPending === value) strictPending = null;
	}
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

<SettingsSection title="Export" description="Download memory as a zip of Markdown files.">
	<SettingsRow
		label="Export memory"
		description="All your memory concepts, private ones included, in their folders."
		stack
	>
		<Button
			variant="outline"
			class="w-full sm:w-auto"
			href="/api/memory/export"
			download
			data-sveltekit-reload
		>
			<DownloadIcon class="size-4" />
			Export
		</Button>
	</SettingsRow>
	{#if isAdmin}
		<SettingsRow
			label="Export shared memory"
			description="Memory shared by everyone on this server."
			stack
		>
			<Button
				variant="outline"
				class="w-full sm:w-auto"
				href="/api/memory/export?scope=shared"
				download
				data-sveltekit-reload
			>
				<DownloadIcon class="size-4" />
				Export shared
			</Button>
		</SettingsRow>
	{/if}
</SettingsSection>

{#if data.privateData.enabled}
	<SettingsSection title="Privacy">
		<SettingsRow
			label="Strict memory privacy"
			for="pref-strict-memory"
			description="Models that can't process private data get nothing from memory or past chats, not even a count of hidden items."
		>
			<Switch id="pref-strict-memory" checked={strict} onCheckedChange={setStrict} />
		</SettingsRow>
	</SettingsSection>
{/if}

{#if isAdmin}
	<SettingsSection title="Search index">
		<SettingsRow
			label="Full-text index"
			description="Lets the assistant search memory by keyword. Rebuild it after changing memory files outside the app."
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
