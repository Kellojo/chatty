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
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { aaRequest as request } from '../artificial-analysis.svelte.js';
	import {
		connectedProviders,
		nameList,
		saveSearchPreferences,
		searchRole,
		WEB_SEARCH_NAMES,
		type WebSearchProvider,
		type WebSearchState
	} from './web-search.js';

	let {
		open = $bindable(false),
		provider,
		info
	}: {
		open?: boolean;
		provider: WebSearchProvider;
		info: WebSearchState;
	} = $props();

	const KEY_COPY = {
		field: 'API key',
		body: (value: string) => ({ apiKey: value }),
		checking: 'Checking key…'
	};

	const COPY = {
		searxng: {
			description:
				'Your own SearXNG instance, a self-hosted metasearch engine. It can be on your private network. Searches the web and news.',
			field: 'Instance URL',
			envVar: 'SEARXNG_URL',
			placeholder: 'http://searxng:8080',
			body: (value: string) => ({ url: value }),
			checking: 'Testing…',
			disconnect: 'Remove the SearXNG URL?',
			keyUrl: null
		},
		brave: {
			...KEY_COPY,
			description:
				"Brave's independent index through the Brave Search API. Searches the web and news, and adds a place search tool (restaurants, shops, sights…).",
			envVar: 'BRAVE_SEARCH_API_KEY',
			placeholder: 'Paste your Brave Search API key',
			disconnect: 'Disconnect Brave Search? Place search goes away with it.',
			keyUrl: 'https://api-dashboard.search.brave.com/app/keys'
		},
		perplexity: {
			...KEY_COPY,
			description:
				"Ranked web results from Perplexity's Search API (no generated answer). Web search only: news searches use the other providers.",
			envVar: 'PERPLEXITY_API_KEY',
			placeholder: 'Paste your Perplexity API key',
			disconnect: 'Disconnect Perplexity?',
			keyUrl: 'https://www.perplexity.ai/account/api/keys'
		}
	} as const;

	const copy = $derived(COPY[provider]);
	const name = $derived(WEB_SEARCH_NAMES[provider]);
	const source = $derived(info[provider].source);
	const configured = $derived(connectedProviders(info));
	const isBackup = $derived(info.backupOnly.includes(provider));
	/** Fallback providers tried before this one; empty when it's already first. */
	const triedBefore = $derived(
		info.order.fallback.slice(0, Math.max(0, info.order.fallback.indexOf(provider)))
	);
	const canMakeDefault = $derived(!isBackup && triedBefore.length > 0);
	let savingPrefs = $state(false);

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
			await request('PUT', `/api/websearch/${provider}`, copy.body(value.trim()));
			toast.success(`${name} connected`);
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
		if (!confirm(copy.disconnect)) return;
		try {
			await request('DELETE', `/api/websearch/${provider}`);
			toast.success(`${name} disconnected`);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not disconnect');
		}
	}

	async function savePrefs(prefs: Parameters<typeof saveSearchPreferences>[0]) {
		savingPrefs = true;
		await saveSearchPreferences(prefs);
		savingPrefs = false;
	}

	const setBackup = (on: boolean) =>
		savePrefs({
			backupOnly: on
				? [...info.backupOnly, provider]
				: info.backupOnly.filter((p) => p !== provider)
		});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{name}</Dialog.Title>
			<Dialog.Description>
				{copy.description} Models use it through the <code class="font-mono">web_search</code> tool.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-5">
			{#if source && !replacing}
				<div class="flex items-center justify-between gap-4 text-sm">
					<div class="flex min-w-0 flex-col gap-1">
						<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="font-medium">{copy.field}</span>
							{#if provider === 'searxng'}
								<span class="truncate font-mono text-muted-foreground">{info.searxng.url}</span>
							{:else}
								<span class="font-mono text-muted-foreground">••••{info[provider].hint}</span>
							{/if}
							{#if source === 'env'}
								<Badge variant="outline" class="font-normal text-muted-foreground"
									>Managed by environment</Badge
								>
							{:else if provider !== 'searxng'}
								<span class="text-muted-foreground">· stored encrypted</span>
							{/if}
						</span>
						{#if source === 'env'}
							<span class="text-sm text-muted-foreground">
								Set via the <code class="font-mono">{copy.envVar}</code> environment variable. Change
								it there and restart the server.
							</span>
						{/if}
					</div>
					{#if source === 'app'}
						<Button variant="outline" size="sm" onclick={() => (replacing = true)}>Replace</Button>
					{/if}
				</div>

				{#if configured.length > 1}
					<!-- Its part in searches; the Web search section explains the modes. -->
					<section
						aria-labelledby="ws-role-title"
						class="flex flex-col gap-3 border-t border-border/60 pt-3 text-sm"
					>
						<div class="flex flex-col gap-0.5">
							<h3 id="ws-role-title" class="font-medium">
								In searches · {info.mode === 'combined' ? 'Combined' : 'Fallback'} mode
							</h3>
							<!-- Two lines reserved, so toggling Backup only doesn't move the controls below. -->
							<p class="min-h-10 text-muted-foreground" aria-live="polite">
								{searchRole(info, provider)}
							</p>
						</div>
						<div class="flex items-center justify-between gap-4">
							<div class="flex flex-col gap-0.5">
								<Label for="ws-backup-only">Backup only</Label>
								<span id="ws-backup-hint" class="text-xs text-muted-foreground">
									Only searched when the other providers fail. Recommended for paid APIs.
								</span>
							</div>
							<Switch
								id="ws-backup-only"
								checked={isBackup}
								disabled={savingPrefs}
								aria-describedby="ws-backup-hint"
								onCheckedChange={setBackup}
							/>
						</div>
						{#if info.mode === 'fallback'}
							<!-- Always shown in Fallback; the button only hides, so the row keeps its size. -->
							<div class="flex items-center justify-between gap-4">
								<span class="text-xs text-muted-foreground">
									{#if isBackup}
										Backup only providers are tried last.
									{:else if canMakeDefault}
										Try {name} first, before {nameList(triedBefore)}.
									{:else}
										{name} is tried first.
									{/if}
								</span>
								<Button
									variant="outline"
									size="sm"
									class={canMakeDefault ? undefined : 'invisible'}
									disabled={savingPrefs || !canMakeDefault}
									onclick={() => savePrefs({ defaultProvider: provider })}>Make default</Button
								>
							</div>
						{/if}
					</section>
				{/if}
			{/if}

			{#if showForm}
				<form id="websearch-form" onsubmit={save} class="flex flex-col gap-2">
					<Label for="websearch-value">{copy.field}</Label>
					<Input
						id="websearch-value"
						type={provider === 'searxng' ? 'url' : 'password'}
						bind:value
						placeholder={copy.placeholder}
						autocomplete="off"
						required
						aria-invalid={fieldError ? 'true' : undefined}
						aria-describedby={fieldError ? 'websearch-error' : undefined}
						oninput={() => (fieldError = null)}
					/>
					{#if fieldError}
						<p
							id="websearch-error"
							role="alert"
							class="flex items-start gap-1.5 text-sm text-destructive"
						>
							<CircleAlertIcon class="mt-0.5 size-3.5 shrink-0" />{fieldError}
						</p>
					{/if}
					{#if provider === 'searxng'}
						<p class="text-xs text-muted-foreground">
							Chatty runs a test search before saving. SearXNG only answers apps when
							<code class="font-mono">json</code> is listed under
							<code class="font-mono">search.formats</code> in its
							<code class="font-mono">settings.yml</code>:
						</p>
						<pre class="rounded-md bg-muted px-3 py-2 font-mono text-xs">search:
  formats:
    - html
    - json</pre>
					{:else if copy.keyUrl}
						<p class="text-xs text-muted-foreground">
							<!-- eslint-disable svelte/no-navigation-without-resolve -- external key page -->
							<a
								class="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-4"
								href={copy.keyUrl}
								target="_blank"
								rel="noreferrer">Get an API key<ExternalLinkIcon class="size-3" /></a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							· The key is checked with a test search before it's saved, and stored encrypted.
						</p>
					{/if}
				</form>
			{/if}
		</div>

		<Dialog.Footer class="gap-2 sm:justify-between">
			{#if showForm}
				<div class="flex gap-2 max-sm:flex-col-reverse sm:ml-auto">
					{#if replacing}
						<Button variant="outline" onclick={() => (replacing = false)}>Cancel</Button>
					{/if}
					<Button type="submit" form="websearch-form" disabled={saving || !value.trim()}>
						{saving ? copy.checking : replacing ? 'Save' : 'Connect'}
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
