<script lang="ts">
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import WaypointsIcon from '@lucide/svelte/icons/waypoints';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import AuthShell from '$lib/components/app/auth/AuthShell.svelte';
	import McpToolPicker from '$lib/components/app/settings/McpToolPicker.svelte';
	import { defaultAccess, toolNamesToAccess } from '$lib/mcp-access.js';
	import type { McpKeyAccess, ToolInfo } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** The page's starting values; it is not re-run with new data. */
	const initial = (() => {
		const d = data;
		return {
			label: d.existing?.label ?? d.client?.name ?? '',
			access: d.existing?.mcpAccess ?? defaultAccess(d.servers ?? [])
		};
	})();

	let label = $state(initial.label);
	const initialAccess: McpKeyAccess = initial.access;
	let tools = $state<ToolInfo[] | null>(null);
	let selected = $state<string[]>([]);
	let busy = $state<'approve' | 'deny' | null>(null);
	/** Set once the answer was sent and the browser is on its way back. */
	let leaving = $state(false);

	async function answer(decision: 'approve' | 'deny') {
		if (busy || !data.client || !data.servers) return;
		if (decision === 'approve' && (!label.trim() || !tools)) return;
		busy = decision;
		try {
			const body =
				decision === 'approve'
					? {
							decision,
							query: data.query,
							label: label.trim(),
							mcpAccess: toolNamesToAccess(selected, initialAccess, data.servers, tools!)
						}
					: { decision, query: data.query };
			const res = await fetch('/api/oauth/authorize', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const payload = (await res.json().catch(() => null)) as {
				redirectTo?: string;
				message?: string;
			} | null;
			if (!res.ok || !payload?.redirectTo) {
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			leaving = true;
			// Back to the app that asked (often another site or a local port), so a full navigation.
			window.location.assign(payload.redirectTo);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Something went wrong');
			busy = null;
		}
	}
</script>

<svelte:head>
	<title>Connect {data.client?.name ?? 'an app'} · Chatty</title>
</svelte:head>

<AuthShell wide>
	<div
		class="flex w-full flex-col gap-6 text-card-foreground sm:rounded-4xl sm:border sm:bg-card sm:px-8 sm:py-8 sm:shadow-sm"
	>
		{#if data.problem || !data.client || !data.servers}
			<header class="flex flex-col items-center gap-3 text-center">
				<span
					class="flex size-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive"
				>
					<CircleAlertIcon class="size-5" aria-hidden="true" />
				</span>
				<h1 class="text-xl font-semibold tracking-tight">Can't connect this app</h1>
				<p class="text-sm text-balance text-muted-foreground">{data.problem}</p>
			</header>
			<Button href={resolve('/')} variant="outline" class="self-center">Go to Chatty</Button>
		{:else if leaving}
			<p
				class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
				role="status"
			>
				<Loader2Icon class="size-4 animate-spin motion-reduce:animate-none" />
				Returning to {data.client.name}…
			</p>
		{:else}
			<header class="flex flex-col items-center gap-3 text-center">
				<span class="flex size-10 items-center justify-center rounded-xl bg-muted">
					<WaypointsIcon class="size-5" aria-hidden="true" />
				</span>
				<h1 class="text-xl font-semibold tracking-tight">
					{data.existing ? 'Reconnect' : 'Connect'}
					{data.client.name} to Chatty
				</h1>
				<p class="text-sm text-balance text-muted-foreground">
					It will use the Chatty tools you pick below as
					<span class="font-medium text-foreground">{data.user?.email}</span>. You'll go back to
					<span class="font-medium break-all text-foreground">{data.client.returnTo}</span>; only
					continue if you started this there.
				</p>
				{#if !data.client.local}
					<p
						class="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-left text-xs text-amber-800 dark:text-amber-300"
					>
						<TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						<span>
							The app picked the name “{data.client.name}” itself; Chatty can't verify it. Trust the
							address above, not the name.
						</span>
					</p>
				{/if}
			</header>

			<div class="flex flex-col gap-2">
				<Label for="oauth-label">Name in your API keys</Label>
				<Input id="oauth-label" bind:value={label} maxlength={100} required />
				<p class="text-xs text-muted-foreground">
					{data.existing
						? 'Approving updates the key from your last sign-in.'
						: 'Approving adds a key you can edit or delete under Settings → API.'}
				</p>
			</div>

			<div class="border-t border-border/60 pt-5">
				<McpToolPicker servers={data.servers} {initialAccess} bind:tools bind:selected />
			</div>

			<div
				class="flex flex-col-reverse gap-2 border-t border-border/60 pt-5 sm:flex-row sm:justify-end"
			>
				<Button variant="ghost" disabled={busy !== null} onclick={() => answer('deny')}>
					{#if busy === 'deny'}<Loader2Icon
							class="size-4 animate-spin motion-reduce:animate-none"
						/>{/if}
					Deny
				</Button>
				<Button
					disabled={busy !== null || !tools || !label.trim()}
					onclick={() => answer('approve')}
				>
					{#if busy === 'approve'}<Loader2Icon
							class="size-4 animate-spin motion-reduce:animate-none"
						/>{/if}
					Allow access
				</Button>
			</div>
		{/if}
	</div>
</AuthShell>
