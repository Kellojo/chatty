<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';

	let name = $state('');
	let title = $state('');
	let description = $state('');
	let body = $state('');
	let busy = $state(false);

	const nameValid = $derived(/^[a-z0-9][a-z0-9-]{0,63}$/.test(name));

	async function create() {
		if (busy || !nameValid || !title.trim() || !description.trim()) return;
		busy = true;
		try {
			const res = await fetch('/api/skills', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: name.trim(),
					title: title.trim(),
					description: description.trim(),
					body
				})
			});
			const data = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(data?.message ?? `Request failed (${res.status})`);
			toast.success('Skill created');
			await invalidateAll();
			await goto(resolve(`/skills/${name.trim()}`));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to create skill');
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
		<h1 class="text-xl font-semibold">New skill</h1>

		<div class="flex flex-col gap-1.5">
			<Label for="name">Name</Label>
			<Input id="name" placeholder="my-skill" bind:value={name} />
			{#if name && !nameValid}
				<p class="text-sm text-destructive">
					Lowercase letters, digits and dashes; must start with a letter or digit.
				</p>
			{/if}
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="title">Title</Label>
			<Input id="title" placeholder="My skill" bind:value={title} />
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="description">Description</Label>
			<Input
				id="description"
				placeholder="One-line summary used by the AI to decide when to load this skill"
				bind:value={description}
			/>
		</div>

		<div class="flex min-h-64 flex-col gap-1.5">
			<Label for="body">Instructions (markdown)</Label>
			<Textarea
				id="body"
				class="min-h-64 flex-1 font-mono text-sm"
				placeholder="Instructions the AI follows when this skill is loaded…"
				bind:value={body}
			/>
		</div>

		<div class="flex justify-end gap-2">
			<Button variant="outline" href={resolve('/skills')}>Cancel</Button>
			<Button
				disabled={busy || !nameValid || !title.trim() || !description.trim()}
				onclick={create}
			>
				{#if busy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
				Create skill
			</Button>
		</div>
	</div>
</div>
