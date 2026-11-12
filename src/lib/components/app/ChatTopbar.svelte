<script lang="ts">
	import { toast } from 'svelte-sonner';
	import ModelPicker from './ModelPicker.svelte';
	import CodingTaskBar from './CodingTaskBar.svelte';
	import ConversationMenu from './ConversationMenu.svelte';
	import HandoffDialog from './HandoffDialog.svelte';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import { MediaQuery } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { getSidebarState } from './sidebar-state.svelte.js';
	import { decodeModelRef, encodeModelRef } from '$lib/model-ref.js';
	import type { Agent, Conversation, ModelMapping, ModelsByProvider } from '$lib/types.js';
	import type { CodingConversation, CodingEnvironment } from '$lib/coding-environments.js';
	import type { CodingBrowserActivity } from '$lib/coding-preview.js';
	import { canCreatePullRequest } from '$lib/coding-task-details.js';

	let {
		conversation,
		groups,
		mappings = [],
		defaultModel,
		personas,
		coding = null,
		codingEnvironmentName = null,
		codingBrowserActivity = null,
		oncreatepr,
		codingEnvironments = [],
		codingAgents = [],
		handoffDisabled = false,
		messageCount,
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
		/** The coding agent's browser use in its current run. */
		codingBrowserActivity?: CodingBrowserActivity | null;
		oncreatepr?: () => void;
		/** Where a chat can be handed off to (empty inside coding tasks). */
		codingEnvironments?: CodingEnvironment[];
		codingAgents?: Agent[];
		/** No messages yet, or a reply is still coming. */
		handoffDisabled?: boolean;
		/** Messages in the chat, so the handoff dialog keeps its draft while it's unchanged. */
		messageCount?: number;
		onupdated: (c: Conversation) => void;
	} = $props();

	let handoffOpen = $state(false);
	// Coding-task dialogs, opened from the task bar or (on phones) from the ⋯ menu.
	let codingSettingsOpen = $state(false);
	let codingPreviewOpen = $state(false);
	const canHandoff = $derived(
		!coding && (codingEnvironments.length > 0 || codingAgents.length > 0)
	);

	let saving = $state(false);

	const sidebar = getSidebarState();
	// Phones put the picker under the title (left), wider screens on the right.
	const isPhone = new MediaQuery('(max-width: 639px)');
	// Room for the floating sidebar button, only as much as it overlaps the centred
	// column: 2.5rem (+ the column's 1rem padding) when the column touches the left
	// edge, shrinking to nothing once the margin beside the column clears the button.
	// Breakpoint classes rather than a JS media query, which renders as mobile on the
	// server and jumps on desktop. On desktop the button only shows with the sidebar closed.
	const sidebarOffset = $derived(
		sidebar === undefined
			? ''
			: sidebar.open
				? 'max-md:pl-[min(2.5rem,max(0px,calc(3.5rem_-_(100%_-_48rem)/2)))]'
				: 'pl-[min(2.5rem,max(0px,calc(3.5rem_-_(100%_-_48rem)/2)))] md:pl-[min(2.5rem,max(0px,calc(4rem_-_(100%_-_48rem)/2)))]'
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
<header class="shrink-0 {sidebarOffset}">
	<div class="mx-auto flex h-12 w-full max-w-3xl items-center gap-1 px-4 md:h-14">
		{#if coding}
			<CodingTaskBar
				{coding}
				title={displayTitle}
				environmentName={codingEnvironmentName}
				{oncreatepr}
				bind:settingsOpen={codingSettingsOpen}
				bind:previewOpen={codingPreviewOpen}
				browserActivity={codingBrowserActivity}
			/>
		{:else}
			<!-- Main info first: what this chat is, then the controls. On phones the model
			     sits under the title as a subtitle, so the title gets the row's full width;
			     from sm up the wrapper dissolves and the picker joins the controls on the right. -->
			<div
				class="flex min-w-0 flex-1 flex-col justify-center max-sm:relative max-sm:self-stretch max-sm:transition-opacity max-sm:active:opacity-60 sm:contents max-sm:pointer-fine:hover:opacity-80"
			>
				<div class="flex min-w-0 items-center gap-1.5">
					<h1
						class="min-w-0 truncate text-[15px] leading-5 font-semibold sm:font-medium md:text-base"
						title={displayTitle}
					>
						{displayTitle}
					</h1>
					{#if personaLabel}
						<Badge variant="secondary" class="shrink-0 max-sm:hidden" title="Persona">
							{personaLabel}
						</Badge>
					{/if}
				</div>
				<!-- Quiet so the title leads. On phones: a small "model ⌄" line, pulled left by
				     its padding so the logo lines up with the title. Its invisible ::after fills
				     the whole title block (the positioned wrapper), so tapping the title opens it too;
				     the block dims as feedback and takes the focus ring. -->
				<ModelPicker
					{groups}
					{mappings}
					value={currentModelValue}
					onselect={selectModel}
					disabled={saving}
					align={isPhone.current ? 'start' : 'end'}
					class="w-auto shrink-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground max-sm:static max-sm:-mx-1.5 max-sm:mt-px max-sm:max-w-full max-sm:gap-0.5 max-sm:self-start max-sm:border-0 max-sm:px-1.5 max-sm:py-0 max-sm:text-xs max-sm:leading-4 max-sm:font-medium max-sm:shadow-none max-sm:after:absolute max-sm:after:-inset-x-1.5 max-sm:after:inset-y-1 max-sm:after:rounded-lg max-sm:after:content-[''] max-sm:hover:bg-transparent max-sm:focus-visible:ring-0 max-sm:focus-visible:after:ring-[3px] max-sm:focus-visible:after:ring-ring/50 max-sm:data-[size=default]:h-auto sm:ml-auto sm:max-w-44 sm:pr-2 sm:data-[size=default]:h-8 lg:max-w-56 sm:pointer-coarse:data-[size=default]:h-10 max-sm:[&_[data-model-icon=brand]>*]:size-3 max-sm:[&_[data-model-icon=generic]]:hidden max-sm:[&_[data-model-source]]:hidden max-sm:[&>svg:last-child]:size-3"
				/>
			</div>
			<div class="flex shrink-0 items-center gap-0.5 sm:gap-1">
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
						<!-- Icon-only until there is room, so the title keeps its space. -->
						<span class="max-lg:sr-only">Hand off</span>
					</Button>
				{/if}
			</div>
		{/if}
		<!-- Pulled out by the icon's inset so the dots line up with the messages' right edge. -->
		<div class="-mr-2 flex shrink-0">
			<ConversationMenu
				{conversation}
				{coding}
				environmentName={codingEnvironmentName}
				{onupdated}
				onhandoff={canHandoff && !handoffDisabled ? () => (handoffOpen = true) : undefined}
				oncreatepr={coding && oncreatepr && canCreatePullRequest(coding) ? oncreatepr : undefined}
				onsettings={coding?.environmentId ? () => (codingSettingsOpen = true) : undefined}
				onpreview={coding?.threadId && coding.environmentId
					? () => (codingPreviewOpen = true)
					: undefined}
			/>
		</div>
	</div>
</header>

{#if canHandoff}
	<HandoffDialog
		bind:open={handoffOpen}
		conversationId={conversation.id}
		{codingEnvironments}
		{codingAgents}
		{messageCount}
	/>
{/if}
