<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
	import type { McpConnectionInfo } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** The server whose sign-in or sign-out is running. */
	let busyId = $state<string | null>(null);

	function host(url: string): string {
		try {
			return new URL(url).host;
		} catch {
			return url;
		}
	}

	async function connect(server: McpConnectionInfo) {
		busyId = server.id;
		try {
			const res = await fetch(`/api/mcp-servers/${server.id}/oauth`, { method: 'POST' });
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.message ?? `Couldn’t connect ${server.name}`);
			if (body.connected) {
				toast.success(`Connected to ${server.name}`);
				await invalidateAll();
				busyId = null;
				return;
			}
			// Off to the authorization server; it sends the browser back to the callback.
			window.location.assign(body.authorizeUrl);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
			busyId = null;
		}
	}

	async function disconnect(server: McpConnectionInfo) {
		busyId = server.id;
		try {
			const res = await fetch(`/api/mcp-servers/${server.id}/oauth`, { method: 'DELETE' });
			if (!res.ok) throw new Error(`Couldn’t disconnect ${server.name}`);
			toast.success(`Disconnected ${server.name}`);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			busyId = null;
		}
	}

	// The OAuth callback lands here with the outcome; show it once and clean the URL.
	onMount(() => {
		const params = page.url.searchParams;
		const connected = params.get('connected');
		const failed = params.get('error');
		if (!connected && !failed) return;
		if (connected) toast.success(`Connected to ${connected}`);
		else if (failed) toast.error(`Couldn’t connect: ${failed}`);
		void goto(resolve('/settings/connections'), { replaceState: true, noScroll: true });
	});
</script>

<SettingsHeader
	title="Connected apps"
	description="Sign in to MCP servers that act on your own account, so the assistant can use their tools as you. Each person connects separately."
/>

<SettingsSection title="MCP servers" flush>
	{#if data.connections.length === 0}
		<div class="border-t border-border/60">
			<EmptyState
				icon={PlugIcon}
				title="Nothing to connect"
				description={data.isAdmin
					? 'Add an MCP server with OAuth sign-in under MCP servers, and it shows up here.'
					: 'An admin hasn’t added any MCP servers that need you to sign in.'}
				compact
			>
				{#if data.isAdmin}
					<Button variant="outline" size="sm" href={resolve('/settings/mcp')}>
						Manage MCP servers
					</Button>
				{/if}
			</EmptyState>
		</div>
	{:else}
		<ul class="divide-y divide-border/60 border-t border-border/60" aria-label="MCP servers">
			{#each data.connections as server (server.id)}
				<SettingsListItem title={server.name}>
					{#snippet leading()}<PlugIcon class="size-4" />{/snippet}
					{#snippet badges()}
						{#if server.connected}
							<Badge variant="secondary" class="text-success-foreground">Connected</Badge>
						{:else}
							<Badge variant="outline">Not connected</Badge>
						{/if}
					{/snippet}
					{#snippet meta()}{host(server.url)}{/snippet}
					{#snippet trailing()}
						{#if server.connected}
							<Button
								variant="ghost"
								size="sm"
								disabled={busyId !== null}
								onclick={() => disconnect(server)}
							>
								{#if busyId === server.id}<Loader2Icon class="size-4 animate-spin" />{/if}
								Disconnect
							</Button>
						{:else}
							<Button size="sm" disabled={busyId !== null} onclick={() => connect(server)}>
								{#if busyId === server.id}<Loader2Icon class="size-4 animate-spin" />{/if}
								Connect
							</Button>
						{/if}
					{/snippet}
				</SettingsListItem>
			{/each}
		</ul>
	{/if}
</SettingsSection>
