<script lang="ts">
	import { toast } from 'svelte-sonner';
	import ModelPicker from './ModelPicker.svelte';
	import CodingTaskBar from './CodingTaskBar.svelte';
	import { getSidebarState } from './sidebar-state.svelte.js';
	import { decodeModelRef, encodeModelRef } from '$lib/model-ref.js';
	import type { Agent, Conversation, ModelMapping, ModelsByProvider } from '$lib/types.js';
	import type { CodingConversation } from '$lib/coding-environments.js';

	let {
		conversation,
		groups,
		mappings = [],
		defaultModel,
		personas,
		coding = null,
		codingEnvironmentName = null,
		onupdated
	}: {
		conversation: Conversation;
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		defaultModel?: { providerId: string; modelId: string } | null;
		personas?: Agent[];
		/** Set for coding tasks: the remote agent's model is fixed, so show the task instead. */
		coding?: CodingConversation | null;
		codingEnvironmentName?: string | null;
		onupdated: (c: Conversation) => void;
	} = $props();

	let saving = $state(false);

	const sidebar = getSidebarState();
	const offsetForSidebar = $derived(
		sidebar !== undefined && (sidebar.isMobile ? !sidebar.mobileOpen : !sidebar.open)
	);

	const defaultModelValue = $derived(defaultModel ? encodeModelRef(defaultModel) : '');
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

<header class="flex items-center gap-3 border-b px-4 py-2 {offsetForSidebar ? 'pl-12' : ''}">
	{#if coding}
		<CodingTaskBar {coding} environmentName={codingEnvironmentName} />
	{:else}
		<ModelPicker
			{groups}
			{mappings}
			value={currentModelValue}
			onselect={selectModel}
			disabled={saving}
		/>

		{#if personas && conversation.agentId}
			<span class="text-sm text-muted-foreground">{personaLabel}</span>
		{/if}
	{/if}
</header>
