<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ModelSelect from '$lib/components/app/ModelSelect.svelte';
	import type { ModelRole } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const roleDescriptions: { role: ModelRole; label: string; description: string }[] = [
		{
			role: 'chat',
			label: 'Default chat model',
			description: 'Used for new conversations when no model has been picked yet.'
		},
		{
			role: 'title',
			label: 'Title generation',
			description: 'Generates conversation titles. Falls back to the conversation model when unset.'
		},
		{
			role: 'memory',
			label: 'Memory',
			description: 'Used by the memory extraction job.'
		},
		{
			role: 'image',
			label: 'Image generation',
			description: 'Used by the generate_image tool. Pick a model with the image capability.'
		},
		{
			role: 'compaction',
			label: 'Chat compaction',
			description:
				'Summarizes long conversations when they outgrow the context window. Falls back to the conversation model when unset; a cheap model works well.'
		}
	];

	const roleCapability: Partial<Record<ModelRole, string>> = { image: 'image' };

	let busy = $state<ModelRole | null>(null);

	const modelsById = $derived(new Map(data.models.map((m) => [m.id, m])));

	const enabledGroups = $derived(
		data.providers
			.filter((p) => p.enabled)
			.map((p) => ({
				provider: p,
				models: data.models.filter((m) => m.providerId === p.id && m.enabled)
			}))
			.filter((g) => g.models.length > 0)
	);

	function roleValue(modelId: string | undefined): string {
		if (!modelId) return '';
		if (modelId.startsWith('mapping:')) {
			const mapping = data.mappings.find((m) => `mapping:${m.id}` === modelId);
			return mapping ? `${modelId}/${mapping.name}` : '';
		}
		const model = modelsById.get(modelId);
		return model ? `${model.providerId}/${model.modelId}` : '';
	}

	function modelIdFromValue(value: string): string | null {
		if (!value) return null;
		if (value.startsWith('mapping:')) return value.split('/')[0];
		const model = data.models.find((m) => `${m.providerId}/${m.modelId}` === value);
		return model?.id ?? null;
	}

	async function setRole(role: ModelRole, value: string) {
		if (busy) return;
		busy = role;
		try {
			const res = await fetch('/api/roles', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ role, modelId: modelIdFromValue(value) })
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			toast.success('Default updated');
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update default');
		} finally {
			busy = null;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<h2 class="text-xl font-semibold">Model defaults</h2>
	<p class="text-sm text-muted-foreground">
		Pick which model serves each purpose. The same model can be used for all of them.
	</p>

	<Card.Root>
		<Card.Content class="flex flex-col gap-5 pt-6">
			{#each roleDescriptions as { role, label, description } (role)}
				<div class="flex items-center justify-between gap-6">
					<div class="flex min-w-0 flex-col gap-1">
						<Label>{label}</Label>
						<p class="text-sm text-muted-foreground">{description}</p>
					</div>
					<ModelSelect
						groups={enabledGroups}
						mappings={data.mappings}
						value={roleValue(data.roles[role])}
						onselect={(value) => setRole(role, value)}
						disabled={busy !== null}
						noneValue=""
						noneLabel="Not set"
						capability={roleCapability[role]}
						class="w-72 shrink-0"
					/>
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	{#if enabledGroups.length === 0}
		<p class="text-sm text-muted-foreground">
			No enabled models yet. Add providers and models first.
		</p>
	{/if}
</div>
