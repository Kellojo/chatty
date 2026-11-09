<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import ModelSelect from '$lib/components/app/ModelSelect.svelte';
	import type { ModelRole } from '$lib/types.js';
	import { MODEL_ROLE_LABEL } from '$lib/model-roles.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const roleDescriptions: { role: ModelRole; label: string; description: string }[] = [
		{
			role: 'chat',
			label: MODEL_ROLE_LABEL['chat'],
			description: 'Used for new conversations when no model has been picked yet.'
		},
		{
			role: 'title',
			label: MODEL_ROLE_LABEL['title'],
			description: "Generates conversation titles. Uses the chat's own model when unset."
		},
		{
			role: 'memory',
			label: MODEL_ROLE_LABEL['memory'],
			description: 'Turns past chats into memory concepts in the background.'
		},
		{
			role: 'image',
			label: MODEL_ROLE_LABEL['image'],
			description: 'Used when the assistant creates images. Pick a model with the image capability.'
		},
		{
			role: 'compaction',
			label: MODEL_ROLE_LABEL['compaction'],
			description:
				"Summarizes long chats near the context limit. Uses the chat's own model when unset; a cheap model works well."
		},
		{
			role: 'speech-to-text',
			label: MODEL_ROLE_LABEL['speech-to-text'],
			description:
				"Transcribes voice input. When unset, the browser's built-in speech recognition is used instead."
		},
		{
			role: 'decisions',
			label: MODEL_ROLE_LABEL['decisions'],
			description:
				'Used by the Decisions API. Pick a model with the decisions capability. Until one is set, Decisions API calls fail.'
		}
	];

	const roleCapability: Partial<Record<ModelRole, string>> = {
		image: 'image',
		'speech-to-text': 'transcription',
		decisions: 'decisions'
	};

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
			toast.success(
				value ? `${MODEL_ROLE_LABEL[role]} updated` : `${MODEL_ROLE_LABEL[role]} cleared`
			);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update default');
		} finally {
			busy = null;
		}
	}
</script>

<svelte:head><title>Defaults · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="Defaults"
	description="Pick which model serves each purpose. One model can serve all of them."
/>

{#if enabledGroups.length === 0}
	<SettingsSection>
		<div class="flex flex-col items-start gap-3 py-2">
			<p class="text-sm text-muted-foreground">
				No enabled models yet. Connect a provider and sync its models first.
			</p>
			<Button size="sm" href={resolve('/settings/providers')}>Go to providers</Button>
		</div>
	</SettingsSection>
{:else}
	<SettingsSection>
		{#each roleDescriptions as { role, label, description } (role)}
			<SettingsRow {label} {description} stack>
				<ModelSelect
					groups={enabledGroups}
					mappings={data.mappings}
					value={roleValue(data.roles[role])}
					onselect={(value) => setRole(role, value)}
					disabled={busy !== null}
					noneValue=""
					noneLabel="Not set"
					capability={roleCapability[role]}
					class="w-full sm:w-72 max-md:[&_[data-model-source]]:hidden"
				/>
			</SettingsRow>
		{/each}
	</SettingsSection>
{/if}
