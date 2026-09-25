<script lang="ts">
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
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

<div class="flex flex-col gap-4">
	<div class="flex flex-col gap-1">
		<h2 class="text-xl font-semibold">Memory</h2>
		<p class="text-sm text-muted-foreground">
			Long-term memory the assistant builds from your conversations.
		</p>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Memory extraction</Card.Title>
			<Card.Description>
				The built-in memory-extraction agent runs automatically on every 5th new chat and distills
				recent conversations into long-term memory concepts. You can also trigger it manually.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-wrap items-center gap-2">
			<Button disabled={extractBusy} onclick={extractNow}>
				{#if extractBusy}
					<LoaderCircleIcon class="size-4 animate-spin" />
					Starting…
				{:else}
					Extract memory now
				{/if}
			</Button>
			<Button variant="outline" href={resolve('/memory')}>Open memory browser</Button>
		</Card.Content>
	</Card.Root>

	{#if isAdmin}
		<Card.Root>
			<Card.Header>
				<Card.Title>Search index</Card.Title>
				<Card.Description>
					Rebuild the full-text search index over all memory bundles. Use this after changing memory
					files outside the app.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Button variant="outline" disabled={reindexBusy} onclick={reindex}>
					{#if reindexBusy}
						<LoaderCircleIcon class="size-4 animate-spin" />
						Rebuilding…
					{:else}
						Rebuild index
					{/if}
				</Button>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
