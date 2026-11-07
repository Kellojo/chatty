<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import EnabledSwitch from '$lib/components/app/EnabledSwitch.svelte';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import type { Agent } from '$lib/types.js';

	let { agent, active }: { agent: Agent; active: 'setup' | 'runs' } = $props();

	let runBusy = $state(false);
	let toggleBusy = $state(false);

	async function setEnabled(enabled: boolean) {
		if (toggleBusy) return;
		toggleBusy = true;
		try {
			const res = await fetch(`/api/agents/${agent.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? `Request failed (${res.status})`);
			}
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update agent');
		} finally {
			toggleBusy = false;
		}
	}

	const tabs = $derived([
		{ key: 'setup', label: 'Setup', href: resolve(`/agents/${agent.id}`) },
		{ key: 'runs', label: 'Runs', href: resolve(`/agents/${agent.id}/runs`) }
	]);

	async function runNow() {
		if (runBusy) return;
		runBusy = true;
		try {
			const res = await fetch(`/api/agents/${agent.id}/run`, { method: 'POST' });
			const body = (await res.json().catch(() => null)) as {
				ignored?: boolean;
				message?: string;
			} | null;
			if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
			if (body?.ignored) toast(body.message ?? 'Run ignored');
			else toast.success('Run started');
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to start run');
		} finally {
			runBusy = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<PageHeader title={agent.name} back={{ href: resolve('/agents'), label: 'Agents' }}>
		{#snippet badges()}
			{#if agent.userId === null}
				<Badge variant="outline">Built-in</Badge>
			{/if}
		{/snippet}
		{#snippet actions()}
			<EnabledSwitch
				checked={agent.enabled}
				disabled={toggleBusy}
				label="Enable {agent.name}"
				onchange={setEnabled}
			/>
			<Button variant="outline" disabled={runBusy} onclick={runNow}>
				{#if runBusy}
					<LoaderCircleIcon class="size-4 animate-spin" />
				{:else}
					<PlayIcon class="size-4" />
				{/if}
				Run now
			</Button>
		{/snippet}
	</PageHeader>
	<nav
		class="-mx-4 flex [scrollbar-width:none] gap-1 overflow-x-auto border-b px-4 md:mx-0 md:px-0"
		aria-label="Agent"
	>
		{#each tabs as tab (tab.key)}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- href comes from resolve() -->
			<a
				href={tab.href}
				aria-current={tab.key === active ? 'page' : undefined}
				class="shrink-0 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors md:py-2 {tab.key ===
				active
					? 'border-foreground font-medium text-foreground'
					: 'border-transparent text-muted-foreground hover:text-foreground'}"
			>
				{tab.label}
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/each}
	</nav>
</div>
