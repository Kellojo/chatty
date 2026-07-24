<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { formatDateTime } from '$lib/datetime.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let title = $state(data.skill.title);
	let description = $state(data.skill.description);
	let when = $state(data.skill.frontmatter.when ?? '');
	let tools = $state(data.skill.frontmatter.tools.join(', '));
	let version = $state(data.skill.version ?? '');
	let author = $state(data.skill.author ?? '');
	let enabled = $state(data.skill.enabled);
	let body = $state(data.skill.body);
	let busy = $state(false);

	const scopeParam = $derived(data.scope === 'shared' ? '?scope=shared' : '');

	async function save() {
		if (busy || !title.trim() || !description.trim()) return;
		busy = true;
		try {
			const res = await fetch(`/api/skills/${data.skill.name}${scopeParam}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: title.trim(),
					description: description.trim(),
					when: when.trim() || null,
					tools: tools
						.split(',')
						.map((t) => t.trim())
						.filter(Boolean),
					version: version.trim() || null,
					author: author.trim() || null,
					enabled,
					body
				})
			});
			const resData = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(resData?.message ?? `Request failed (${res.status})`);
			toast.success('Skill saved');
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save skill');
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (busy) return;
		busy = true;
		try {
			const res = await fetch(`/api/skills/${data.skill.name}${scopeParam}`, { method: 'DELETE' });
			if (!res.ok) {
				const resData = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(resData?.message ?? `Request failed (${res.status})`);
			}
			toast.success('Skill deleted');
			await invalidateAll();
			await goto(resolve('/skills'));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete skill');
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2">
				<h1 class="text-xl font-semibold">{data.skill.name}</h1>
				<Badge variant="outline">{data.scope}</Badge>
				<Badge variant="secondary">{data.skill.source}</Badge>
			</div>
			<Button variant="destructive" size="sm" onclick={remove} disabled={busy}>Delete</Button>
		</div>

		<div class="flex items-center gap-2">
			<Switch checked={enabled} onCheckedChange={(c) => (enabled = c)} />
			<span class="text-sm text-muted-foreground">{enabled ? 'Enabled' : 'Disabled'}</span>
		</div>

		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="title">Title</Label>
				<Input id="title" bind:value={title} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="version">Version</Label>
				<Input id="version" placeholder="1.0.0" bind:value={version} />
			</div>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="description">Description</Label>
			<Input id="description" bind:value={description} />
		</div>

		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="when">When to use (optional)</Label>
				<Input id="when" placeholder="Free-text guidance for the model" bind:value={when} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="tools">Expected tools (comma-separated)</Label>
				<Input id="tools" placeholder="webfetch, search_memory" bind:value={tools} />
			</div>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="author">Author</Label>
			<Input id="author" bind:value={author} />
		</div>

		<div class="flex min-h-72 flex-col gap-1.5">
			<Label for="body">Instructions (markdown)</Label>
			<Textarea id="body" class="min-h-72 flex-1 font-mono text-sm" bind:value={body} />
		</div>

		{#if data.skill.references.length > 0}
			<div class="flex flex-col gap-1.5">
				<Label>Reference files</Label>
				<ul class="text-sm text-muted-foreground">
					{#each data.skill.references as ref (ref)}
						<li class="font-mono">{ref}</li>
					{/each}
				</ul>
				<p class="text-xs text-muted-foreground">
					Reference files live on disk next to skill.md and can only be edited there.
				</p>
			</div>
		{/if}

		<div class="flex justify-end">
			<Button disabled={busy || !title.trim() || !description.trim()} onclick={save}>
				{#if busy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
				Save
			</Button>
		</div>

		{#if data.invocations.length > 0}
			<div class="mt-4 flex flex-col gap-2">
				<h2 class="text-lg font-semibold">Recent invocations</h2>
				<ul class="flex flex-col gap-1 text-sm">
					{#each data.invocations as inv (inv.id)}
						<li class="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5">
							<span class="flex items-center gap-2">
								<Badge variant="outline">{inv.triggered_by}</Badge>
								{#if inv.conversation_id}
									<a
										class="text-primary hover:underline"
										href={resolve(`/chat/${inv.conversation_id}`)}
									>
										conversation
									</a>
								{:else}
									<span class="text-muted-foreground">no conversation</span>
								{/if}
							</span>
							<span class="text-muted-foreground">{formatDateTime(inv.created_at, data.timeFormat)}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
</div>
