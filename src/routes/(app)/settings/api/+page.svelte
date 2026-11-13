<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { formatDateTime } from '$lib/datetime.js';
	import { formatSpend } from '$lib/formats.js';
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import ApiKeyUsageStats from '$lib/components/app/settings/ApiKeyUsageStats.svelte';
	import ApiKeyDialog from '$lib/components/app/settings/ApiKeyDialog.svelte';
	import ApiGuides, { GUIDES, type Guide } from '$lib/components/app/settings/api/ApiGuides.svelte';
	import type { ApiScope } from '$lib/components/app/settings/api/scopes.js';
	import { defaultAccess, describeAccess } from '$lib/mcp-access.js';
	import { DEFAULT_USAGE_PERIOD, type UsagePeriod } from '$lib/components/app/usage/usage.js';
	import type { ApiKey } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const origin = $derived(page.url.origin);

	let keyDialogOpen = $state(false);
	/** The key the dialog edits; null creates one. */
	let editingKey = $state<ApiKey | null>(null);
	let keyPreset = $state<ApiScope>('llm:invoke');
	let deleteKeyBusy = $state<string | null>(null);
	let deleteKeyId = $state<string | null>(null);

	async function api(path: string, method: string, body?: unknown): Promise<Response> {
		const res = await fetch(path, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!res.ok) {
			const payload = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(payload?.message ?? `Request failed (${res.status})`);
		}
		return res;
	}

	/** Opens the key dialog: a new key starting with `preset`, or `key` to edit. */
	function openKeyDialog(preset: ApiScope = 'llm:invoke', key: ApiKey | null = null) {
		keyPreset = preset;
		editingKey = key;
		keyDialogOpen = true;
	}

	/** What a gateway key may use, for its row. */
	function accessLabel(key: ApiKey): string {
		const servers = data.gateway.servers;
		return `MCP: ${describeAccess(key.mcpAccess ?? defaultAccess(servers), servers)}${key.mcpAccess ? '' : ' (defaults)'}`;
	}

	/** The usage line under a key: its recent requests and spend, or that it sat idle. */
	function usageLabel(key: ApiKey): string {
		const usage = data.keyUsage[key.id];
		const toolCalls = data.gateway.usage.byKey[key.id]?.calls ?? 0;
		const window = `the last ${data.keyUsageDays} days`;
		if (!usage) {
			return toolCalls ? `${toolCallsLabel(toolCalls)} in ${window}` : `No requests in ${window}`;
		}
		const parts = [
			`${usage.requests.toLocaleString()} ${usage.requests === 1 ? 'request' : 'requests'}`
		];
		if (usage.runs) parts.push(`${usage.runs} agent ${usage.runs === 1 ? 'run' : 'runs'}`);
		if (usage.pricedRequests) {
			const lower = usage.pricedRequests < usage.requests ? '+' : '';
			parts.push(`${formatSpend(usage.costUsd)}${lower}`);
		}
		if (toolCalls) parts.push(toolCallsLabel(toolCalls));
		return `${parts.join(' · ')} in ${window}`;
	}

	function toolCallsLabel(calls: number): string {
		return `${calls.toLocaleString()} MCP tool ${calls === 1 ? 'call' : 'calls'}`;
	}

	const TABS = ['keys', 'statistics'] as const;
	type Tab = (typeof TABS)[number];
	const asTab = (value: string | null): Tab => TABS.find((tab) => tab === value) ?? 'keys';
	// The tab, guide and statistics period live in the URL, so a reload or a shared link keeps them.
	const activeTab = $derived<Tab>(asTab(page.url.searchParams.get('tab')));
	// The old MCP gateway tab now opens its guide.
	const activeGuide = $derived<Guide>(
		page.url.searchParams.get('tab') === 'mcp'
			? 'mcp'
			: (GUIDES.find((g) => g === page.url.searchParams.get('guide')) ?? 'inference')
	);

	/** This page with `updates` applied to its query (defaults drop the param). */
	function navigate(updates: { tab?: Tab; guide?: Guide; period?: UsagePeriod }) {
		// A throwaway copy for building one href, not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams(page.url.searchParams);
		if (updates.tab) params.set('tab', updates.tab);
		if (updates.guide) params.set('guide', updates.guide);
		if (updates.period) params.set('period', updates.period);
		if (params.get('tab') === 'keys' || params.get('tab') === 'mcp') params.delete('tab');
		if (params.get('guide') === 'inference') params.delete('guide');
		if (params.get('period') === DEFAULT_USAGE_PERIOD) params.delete('period');
		const qs = params.toString();
		// The resolved path of this page plus its own query.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(`${resolve('/settings/api')}${qs ? `?${qs}` : ''}`, {
			keepFocus: true,
			noScroll: true,
			replaceState: true
		});
	}

	function selectTab(value: string) {
		navigate({ tab: asTab(value) });
	}

	async function deleteKey(id: string) {
		deleteKeyId = id;
	}

	async function confirmDeleteKey() {
		if (!deleteKeyId || deleteKeyBusy) return;
		deleteKeyBusy = deleteKeyId;
		try {
			await api(`/api/api-keys/${deleteKeyId}`, 'DELETE');
			toast.success('API key deleted');
			deleteKeyId = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete API key');
		} finally {
			deleteKeyBusy = null;
		}
	}
</script>

<svelte:head><title>API · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="API"
	description="Call your models, use Chatty's tools from MCP clients and start agents from other apps. API keys act as you, so treat them like passwords."
>
	{#snippet actions()}
		<Button onclick={() => openKeyDialog()}><PlusIcon class="size-4" />Create key</Button>
	{/snippet}
</SettingsHeader>

<Tabs.Root value={activeTab} onValueChange={selectTab} class="gap-6">
	<Tabs.List class="self-start">
		<Tabs.Trigger value="keys"><KeyRoundIcon class="size-4" aria-hidden="true" />Keys</Tabs.Trigger>
		<Tabs.Trigger value="statistics">
			<ChartColumnIcon class="size-4" aria-hidden="true" />Statistics
		</Tabs.Trigger>
	</Tabs.List>
	<Tabs.Content value="keys" class="flex flex-col gap-6">
		<SettingsSection title="API keys" flush>
			{#snippet description()}
				Scope a key to <code class="rounded bg-muted px-1 py-0.5 text-xs">agents:run</code>,
				<code class="rounded bg-muted px-1 py-0.5 text-xs">llm:invoke</code>,
				<code class="rounded bg-muted px-1 py-0.5 text-xs">mcp:use</code> or any mix.
			{/snippet}
			{#if data.apiKeys.length === 0}
				<div
					class="flex flex-col items-center gap-3 border-t border-border/60 px-6 pt-6 pb-4 text-center"
				>
					<div
						class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
					>
						<KeyRoundIcon class="size-5" />
					</div>
					<div class="flex flex-col gap-1">
						<p class="text-sm font-medium">No API keys yet</p>
						<p class="text-sm text-muted-foreground">
							Create one to start agent runs, call models or use Chatty's tools from other apps.
						</p>
					</div>
				</div>
			{:else}
				<ul class="divide-y divide-border/60 border-t border-border/60" aria-label="API keys">
					{#each data.apiKeys as key (key.id)}
						<SettingsListItem title={key.label} onclick={() => openKeyDialog('llm:invoke', key)}>
							{#snippet leading()}<KeyRoundIcon class="size-4" />{/snippet}
							{#snippet badges()}
								{#each key.scopes as scope (scope)}
									<Badge variant="secondary" class="font-mono font-normal">{scope}</Badge>
								{/each}
								{#if key.oauthClient}
									<Badge variant="outline" class="font-normal text-muted-foreground"
										>Signed in · {key.oauthClient}</Badge
									>
								{/if}
							{/snippet}
							{#snippet meta()}
								Created {formatDateTime(key.createdAt, data.timeFormat)} · {key.lastUsedAt
									? `Last used ${formatDateTime(key.lastUsedAt, data.timeFormat)}`
									: 'Never used'}
							{/snippet}
							<p class="text-xs text-muted-foreground">{usageLabel(key)}</p>
							{#if key.scopes.includes('mcp:use')}
								<p class="truncate text-xs text-muted-foreground">{accessLabel(key)}</p>
							{/if}
							{#snippet trailing()}
								<Button
									variant="ghost"
									size="icon-sm"
									class="text-muted-foreground"
									title="Edit key"
									aria-label="Edit key {key.label}"
									onclick={() => openKeyDialog('llm:invoke', key)}
								>
									<PencilIcon class="size-4" />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									class="text-muted-foreground hover:text-destructive"
									title="Delete key"
									aria-label="Delete key {key.label}"
									disabled={deleteKeyBusy !== null}
									onclick={() => deleteKey(key.id)}
								>
									<Trash2Icon class="size-4" />
								</Button>
							{/snippet}
						</SettingsListItem>
					{/each}
				</ul>
			{/if}
		</SettingsSection>

		<ApiGuides
			guide={activeGuide}
			onGuideChange={(guide) => navigate({ guide })}
			{origin}
			keys={data.apiKeys}
			gateway={data.gateway}
			agents={data.agents}
			isAdmin={data.user.role === 'admin'}
			onCreateKey={(scope) => openKeyDialog(scope)}
			onEditKey={(key) => openKeyDialog('llm:invoke', key)}
		/>
	</Tabs.Content>
	<Tabs.Content value="statistics">
		<ApiKeyUsageStats
			stats={data.stats}
			period={data.stats.period}
			keys={data.apiKeys}
			onPeriodChange={(period) => navigate({ period })}
		/>
	</Tabs.Content>
</Tabs.Root>

<ApiKeyDialog
	bind:open={keyDialogOpen}
	key={editingKey}
	preset={keyPreset}
	servers={data.gateway.servers}
	onSaved={() => invalidateAll()}
/>

<Dialog.Root open={deleteKeyId !== null} onOpenChange={(open) => !open && (deleteKeyId = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title
				>Delete key {data.apiKeys.find((k) => k.id === deleteKeyId)?.label ?? ''}?</Dialog.Title
			>
			<Dialog.Description>
				Any service using this key will immediately lose access. This cannot be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteKeyId = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteKeyBusy !== null} onclick={confirmDeleteKey}>
				{deleteKeyBusy === deleteKeyId ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
