<script lang="ts">
	import { toast } from 'svelte-sonner';
	import ModelPicker from './ModelPicker.svelte';
	import CodingTaskBar from './CodingTaskBar.svelte';
	import ConversationMenu from './ConversationMenu.svelte';
	import HandoffDialog from './HandoffDialog.svelte';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import { Button } from '$lib/components/ui/button/index.js';
	import { getSidebarState } from './sidebar-state.svelte.js';
	import { decodeModelRef, encodeModelRef } from '$lib/model-ref.js';
	import type { Agent, Conversation, ModelMapping, ModelsByProvider } from '$lib/types.js';
	import type { CodingConversation, CodingEnvironment } from '$lib/coding-environments.js';
	import { agentIsFree, hasPullRequestWork } from '$lib/coding-task-details.js';

	let {
		conversation,
		groups,
		mappings = [],
		defaultModel,
		personas,
		coding = null,
		codingEnvironmentName = null,
		oncreatepr,
		codingEnvironments = [],
		codingAgents = [],
		handoffDisabled = false,
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
		oncreatepr?: () => void;
		/** Where a chat can be handed off to (empty inside coding tasks). */
		codingEnvironments?: CodingEnvironment[];
		codingAgents?: Agent[];
		/** No messages yet, or a reply is still coming. */
		handoffDisabled?: boolean;
		onupdated: (c: Conversation) => void;
	} = $props();

	let handoffOpen = $state(false);
	const canHandoff = $derived(
		!coding && (codingEnvironments.length > 0 || codingAgents.length > 0)
	);

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

	const displayTitle = $derived(conversation.title || (coding ? 'New task' : 'New chat'));

	const personaLabel = $derived(
		conversation.agentId
			? (personas?.find((p) => p.id === conversation.agentId)?.name ?? null)
			: null
	);
</script>

<!-- Same centred column as the messages, so the header reads as part of the chat. -->
<header class="shrink-0">
	<div
		class="mx-auto flex h-12 w-full max-w-3xl items-center gap-2 px-4 {offsetForSidebar
			? 'pl-14 lg:pl-4'
			: ''}"
	>
		{#if coding}
			<CodingTaskBar {coding} title={displayTitle} {oncreatepr} />
		{:else}
			<!-- Main info first: what this chat is, then the controls. -->
			<h1 class="min-w-0 truncate text-sm font-medium" title={displayTitle}>{displayTitle}</h1>
			{#if personaLabel}
				<span class="shrink-0 text-xs text-muted-foreground max-sm:hidden" title="Persona">
					{personaLabel}
				</span>
			{/if}
			<div class="flex-1"></div>
			<!-- Quiet controls so the title leads; on phones the picker is just its provider icon. -->
			<ModelPicker
				{groups}
				{mappings}
				value={currentModelValue}
				onselect={selectModel}
				disabled={saving}
				class="w-auto shrink-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground data-[size=default]:h-8 sm:max-w-56 max-sm:[&_.truncate]:sr-only"
			/>
			{#if canHandoff}
				<Button
					variant="ghost"
					size="sm"
					class="shrink-0 text-muted-foreground hover:text-foreground max-sm:hidden"
					disabled={handoffDisabled}
					title="Hand this chat off to a coding agent"
					aria-label="Hand off to a coding agent"
					onclick={() => (handoffOpen = true)}
				>
					<SquareTerminalIcon />
					<span class="hidden sm:inline">Hand off</span>
				</Button>
			{/if}
		{/if}
		<ConversationMenu
			{conversation}
			{coding}
			environmentName={codingEnvironmentName}
			{onupdated}
			onhandoff={canHandoff && !handoffDisabled ? () => (handoffOpen = true) : undefined}
			oncreatepr={coding && oncreatepr && hasPullRequestWork(coding) && agentIsFree(coding)
				? oncreatepr
				: undefined}
		/>
	</div>
</header>

{#if canHandoff}
	<HandoffDialog
		bind:open={handoffOpen}
		conversationId={conversation.id}
		{codingEnvironments}
		{codingAgents}
	/>
{/if}
