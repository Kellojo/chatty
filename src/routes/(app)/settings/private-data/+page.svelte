<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import PrivateDataDiagram from '$lib/components/app/settings/PrivateDataDiagram.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Shown while a change is saving, until the refreshed data agrees.
	let pending = $state<boolean | null>(null);
	const enabled = $derived(pending ?? data.privateDataEnabled);

	async function setPrivateData(value: boolean) {
		pending = value;
		try {
			const res = await fetch('/api/settings/private-data', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ privateDataEnabled: value })
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			toast.success(value ? 'Private data is on' : 'Private data controls are hidden');
			// The app shell's privateData status shows or hides every private control.
			await invalidateAll().catch(() => undefined);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't change the setting. Try again.");
		}
		if (pending === value) pending = null;
	}

	// The user's own default for new chats (saved with their other settings).
	let defaultPending = $state<boolean | null>(null);
	const privateByDefault = $derived(defaultPending ?? data.privateByDefault);

	async function setPrivateByDefault(value: boolean) {
		defaultPending = value;
		try {
			const res = await fetch('/api/user/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ privateByDefault: value })
			});
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			await invalidateAll().catch(() => undefined);
		} catch {
			toast.error("Couldn't change the setting. Try again.");
		}
		if (defaultPending === value) defaultPending = null;
	}

	const hasTrusted = $derived(data.trustedProviders.length > 0);
</script>

<svelte:head><title>Private data · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="Private data"
	description="Private chats, memory notes, documents and agents only reach models on providers trusted with private data."
/>

{#if data.isAdmin}
	<SettingsSection title="For everyone on this Chatty">
		<SettingsRow
			label="Allow private data"
			for="general-private-data"
			description="Shows the lock in chats and the Private switch for memory notes and agents. Turning it off only hides these: what is already private stays private."
		>
			<Switch id="general-private-data" checked={enabled} onCheckedChange={setPrivateData} />
		</SettingsRow>
		<div class="flex flex-col gap-2.5 pb-1 text-sm">
			{#if data.trustedProviders.length === 0}
				<p
					class="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-300"
					role="note"
				>
					<ShieldAlertIcon class="mt-px size-4 shrink-0" aria-hidden="true" />
					<span>
						No provider may process private data yet, so nothing can be made private. Turn on
						<strong class="font-medium">Can process private data</strong> for a provider in
						<a
							class="font-medium underline decoration-current/40 underline-offset-2 hover:decoration-current"
							href={resolve('/settings/providers')}>Providers</a
						>.
					</span>
				</p>
			{:else}
				<p class="text-muted-foreground">
					Change which providers are trusted in
					<a
						class="font-medium text-foreground underline decoration-current/40 underline-offset-2 hover:decoration-current"
						href={resolve('/settings/providers')}>Providers</a
					>.
				</p>
			{/if}
		</div>
	</SettingsSection>
{/if}

{#if enabled}
	<SettingsSection title="Your chats">
		<SettingsRow
			label="New chats are private"
			for="pref-private-by-default"
			description={hasTrusted
				? 'New chats start with the lock on. You can still turn it off per chat.'
				: 'Takes effect once a provider is trusted with private data.'}
		>
			<Switch
				id="pref-private-by-default"
				checked={privateByDefault}
				onCheckedChange={setPrivateByDefault}
			/>
		</SettingsRow>
	</SettingsSection>

	<SettingsSection title="How it works">
		<PrivateDataDiagram trustedProviders={data.trustedProviders} class="mb-1" />
	</SettingsSection>
{/if}
