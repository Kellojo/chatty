<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import ModelPicker from './ModelPicker.svelte';
	import { decodeModelRef, encodeModelRef } from '$lib/model-ref.js';
	import type { Agent, Conversation, ModelMapping, ModelsByProvider } from '$lib/types.js';

	let {
		conversation,
		groups,
		mappings = [],
		defaultModel,
		personas,
		personaLocked = false,
		onupdated
	}: {
		conversation: Conversation;
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		defaultModel?: { providerId: string; modelId: string } | null;
		personas?: Agent[];
		personaLocked?: boolean;
		onupdated: (c: Conversation) => void;
	} = $props();

	let saving = $state(false);

	const defaultModelValue = $derived(
		defaultModel ? encodeModelRef(defaultModel) : ''
	);
	const currentModelValue = $derived(
		conversation.providerId && conversation.modelId
			? encodeModelRef({ providerId: conversation.providerId, modelId: conversation.modelId })
			: defaultModelValue
	);

	async function patch(body: Record<string, unknown>) {
		saving = true;
		try {
			const res = await fetch(`/api/conversations/${conversation.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message ?? 'Failed to update conversation');
			}
			const { conversation: updated } = (await res.json()) as { conversation: Conversation };
			onupdated(updated);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update conversation');
		} finally {
			saving = false;
		}
	}

	function selectModel(value: string) {
		const { providerId, modelId } = decodeModelRef(value);
		patch({ providerId, modelId });
	}

	const personaLabel = $derived(
		conversation.agentId
			? (personas?.find((p) => p.id === conversation.agentId)?.name ?? 'Persona')
			: 'No persona'
	);
</script>

<header class="flex items-center gap-3 border-b px-4 py-2">
	<ModelPicker {groups} {mappings} value={currentModelValue} onselect={selectModel} disabled={saving} />

	{#if personas && conversation.agentId}
		<span class="text-sm text-muted-foreground">{personaLabel}</span>
	{/if}

	<div class="ml-auto flex items-center gap-3">
		<Label class="flex items-center gap-2 text-sm text-muted-foreground">
			Agent mode
			<Switch
				checked={conversation.mode === 'agent'}
				disabled={saving}
				onCheckedChange={(v) => patch({ mode: v ? 'agent' : 'chat' })}
			/>
		</Label>
	</div>
</header>
