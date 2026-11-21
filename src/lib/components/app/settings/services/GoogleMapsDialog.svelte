<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { aaRequest as request } from '../artificial-analysis.svelte.js';

	/** The Google part of the server's `MapsInfo`. */
	type GoogleMapsState = { source: 'env' | 'app' | null; hint: string | null };

	let {
		open = $bindable(false),
		info
	}: {
		open?: boolean;
		info: GoogleMapsState;
	} = $props();

	const KEY_URL = 'https://console.cloud.google.com/google/maps-apis/credentials';

	const source = $derived(info.source);

	let replacing = $state(false);
	let value = $state('');
	let saving = $state(false);
	let fieldError = $state<string | null>(null);
	const showForm = $derived(!source || replacing);

	$effect(() => {
		if (!open) {
			replacing = false;
			value = '';
			fieldError = null;
		}
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		try {
			fieldError = null;
			await request('PUT', '/api/maps/google', { apiKey: value.trim() });
			toast.success('Google Maps connected');
			replacing = false;
			value = '';
			await invalidateAll();
		} catch (e) {
			fieldError = e instanceof Error ? e.message : 'Could not save';
		} finally {
			saving = false;
		}
	}

	async function disconnect() {
		if (!confirm('Disconnect Google Maps? Chat maps go back to OpenStreetMap tiles.')) return;
		try {
			await request('DELETE', '/api/maps/google');
			toast.success('Google Maps disconnected');
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not disconnect');
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Google Maps</Dialog.Title>
			<Dialog.Description>
				A Google Maps Platform key adds place search with photos and reviews, tried ahead of Brave
				and SearXNG, and shows Google map tiles in chat maps.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-5">
			{#if source && !replacing}
				<div class="flex items-center justify-between gap-4 text-sm">
					<div class="flex min-w-0 flex-col gap-1">
						<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="font-medium">API key</span>
							<span class="font-mono text-muted-foreground">••••{info.hint}</span>
							{#if source === 'env'}
								<Badge variant="outline" class="font-normal text-muted-foreground"
									>Managed by environment</Badge
								>
							{:else}
								<span class="text-muted-foreground">· stored encrypted</span>
							{/if}
						</span>
						{#if source === 'env'}
							<span class="text-sm text-muted-foreground">
								Set via the <code class="font-mono">GOOGLE_MAPS_API_KEY</code> environment variable. Change
								it there and restart the server.
							</span>
						{/if}
					</div>
					{#if source === 'app'}
						<Button variant="outline" size="sm" onclick={() => (replacing = true)}>Replace</Button>
					{/if}
				</div>
			{/if}

			{#if showForm}
				<form id="google-maps-form" onsubmit={save} class="flex flex-col gap-2">
					<Label for="google-maps-value">API key</Label>
					<Input
						id="google-maps-value"
						type="password"
						bind:value
						placeholder="Paste your Google Maps Platform API key"
						autocomplete="off"
						required
						aria-invalid={fieldError ? 'true' : undefined}
						aria-describedby={fieldError ? 'google-maps-error' : undefined}
						oninput={() => (fieldError = null)}
					/>
					{#if fieldError}
						<p
							id="google-maps-error"
							role="alert"
							class="flex items-start gap-1.5 text-sm text-destructive"
						>
							<CircleAlertIcon class="mt-0.5 size-3.5 shrink-0" />{fieldError}
						</p>
					{/if}
					<p class="text-xs text-muted-foreground">
						The key needs the <span class="font-medium text-foreground">Places API (New)</span> and
						<span class="font-medium text-foreground">Map Tiles API</span> enabled on a Google Cloud project
						with billing. Google bills per request beyond its free monthly usage.
					</p>
					<p class="text-xs text-muted-foreground">
						<!-- eslint-disable svelte/no-navigation-without-resolve -- external key page -->
						<a
							class="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-4"
							href={KEY_URL}
							target="_blank"
							rel="noreferrer">Create an API key<ExternalLinkIcon class="size-3" /></a
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						· The key is checked against both APIs before it's saved, and stored encrypted.
					</p>
				</form>
			{/if}
		</div>

		<Dialog.Footer class="gap-2 sm:justify-between">
			{#if showForm}
				<div class="flex gap-2 max-sm:flex-col-reverse sm:ml-auto">
					{#if replacing}
						<Button variant="outline" onclick={() => (replacing = false)}>Cancel</Button>
					{/if}
					<Button type="submit" form="google-maps-form" disabled={saving || !value.trim()}>
						{saving ? 'Checking key…' : replacing ? 'Save' : 'Connect'}
					</Button>
				</div>
			{:else}
				{#if source === 'app'}
					<Button variant="ghost" class="text-destructive sm:mr-auto" onclick={disconnect}
						>Disconnect</Button
					>
				{/if}
				<Button class="sm:ml-auto" onclick={() => (open = false)}>Done</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
