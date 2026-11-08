<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { Conversation } from '$lib/types.js';
	import type { CodingConversation } from '$lib/coding-environments.js';
	import CodingTaskDetails from './CodingTaskDetails.svelte';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import GitPullRequestCreateIcon from '@lucide/svelte/icons/git-pull-request-create';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	/** The header's "⋯" menu: conversation actions, plus task details for coding tasks. */
	let {
		conversation,
		coding = null,
		environmentName = null,
		onupdated,
		onhandoff,
		oncreatepr,
		onsettings,
		onpreview
	}: {
		conversation: Conversation;
		coding?: CodingConversation | null;
		environmentName?: string | null;
		onupdated: (c: Conversation) => void;
		/** Shown on phones, where the header has no room for the Hand off button. */
		onhandoff?: () => void;
		/** Shown on phones, where the header keeps only the title and this menu. */
		oncreatepr?: () => void;
		/** Coding tasks on phones: the header's model/permissions button. */
		onsettings?: () => void;
		/** Coding tasks on phones: the header's browser preview button. */
		onpreview?: () => void;
	} = $props();

	let renaming = $state(false);
	let renameText = $state('');
	let deleting = $state(false);

	const settled = $derived(conversation.settledAt !== null);
	const noun = $derived(coding ? 'task' : 'conversation');

	async function request(path: string, init: RequestInit, failure: string): Promise<boolean> {
		const res = await fetch(`/api/conversations/${conversation.id}${path}`, init).catch(() => null);
		if (!res?.ok) {
			toast.error(failure);
			return false;
		}
		return true;
	}

	async function togglePin() {
		if (await request('/pin', { method: 'POST' }, 'Failed to update pin')) {
			onupdated({ ...conversation, pinned: !conversation.pinned });
			await invalidateAll();
		}
	}

	async function toggleSettled() {
		const ok = await request(
			'/settle',
			{ method: settled ? 'DELETE' : 'POST' },
			settled ? 'Failed to un-settle' : 'Failed to settle'
		);
		if (!ok) return;
		onupdated({
			...conversation,
			settledAt: settled ? null : Date.now(),
			settledReason: settled ? null : 'manual',
			pinned: settled ? conversation.pinned : false
		});
		toast.success(
			settled
				? `${coding ? 'Task' : 'Conversation'} un-settled`
				: `${coding ? 'Task' : 'Conversation'} settled`
		);
		await invalidateAll();
	}

	function openRename() {
		renameText = conversation.title;
		renaming = true;
	}

	async function submitRename(event: SubmitEvent) {
		event.preventDefault();
		const title = renameText.trim();
		renaming = false;
		if (title === conversation.title) return;
		const ok = await request(
			'',
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title })
			},
			'Failed to rename'
		);
		if (ok) {
			onupdated({ ...conversation, title });
			await invalidateAll();
		}
	}

	async function confirmDelete() {
		deleting = false;
		if (await request('', { method: 'DELETE' }, `Failed to delete ${noun}`)) {
			toast.success(coding ? 'Task deleted' : 'Conversation deleted');
			await goto(resolve('/'));
			await invalidateAll();
		}
	}
</script>

<DropdownMenu.DropdownMenu>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon-sm"
				class="aria-expanded:bg-muted/60 dark:aria-expanded:bg-muted/40"
				aria-label={coding ? 'Task details and actions' : 'Conversation actions'}
				title={coding ? 'Task details and actions' : 'Conversation actions'}
			>
				<EllipsisIcon />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content
		align="end"
		collisionPadding={8}
		class="max-w-[calc(100vw-1rem)] {coding ? 'w-80' : 'w-52'}"
	>
		<!-- Phone-only actions (the header has no room for them) lead the menu. -->
		{#if oncreatepr}
			<DropdownMenu.Item class="sm:hidden" onSelect={oncreatepr}>
				<GitPullRequestCreateIcon class="size-4" />
				Create pull request
			</DropdownMenu.Item>
			<DropdownMenu.Separator class="sm:hidden" />
		{/if}
		{#if onsettings || onpreview}
			{#if onsettings}
				<DropdownMenu.Item class="sm:hidden" onSelect={onsettings}>
					<SlidersHorizontalIcon class="size-4" />
					Model and permissions
				</DropdownMenu.Item>
			{/if}
			{#if onpreview}
				<DropdownMenu.Item class="sm:hidden" onSelect={onpreview}>
					<GlobeIcon class="size-4" />
					Browser preview
				</DropdownMenu.Item>
			{/if}
			<DropdownMenu.Separator class="sm:hidden" />
		{/if}
		{#if onhandoff}
			<DropdownMenu.Item class="sm:hidden" onSelect={onhandoff}>
				<SquareTerminalIcon class="size-4" />
				Hand off to coding agent
			</DropdownMenu.Item>
			<DropdownMenu.Separator class="sm:hidden" />
		{/if}

		{#if coding}
			<CodingTaskDetails {coding} {environmentName} />
			<DropdownMenu.Separator />
		{/if}
		<DropdownMenu.Item onSelect={openRename}>
			<PencilIcon class="size-4" />
			Rename
		</DropdownMenu.Item>
		{#if !settled}
			<DropdownMenu.Item onSelect={togglePin}>
				{#if conversation.pinned}
					<PinOffIcon class="size-4" /> Unpin
				{:else}
					<PinIcon class="size-4" /> Pin
				{/if}
			</DropdownMenu.Item>
		{/if}
		<DropdownMenu.Item onSelect={toggleSettled}>
			{#if settled}
				<ArchiveRestoreIcon class="size-4" /> Un-settle
			{:else}
				<ArchiveIcon class="size-4" /> Settle
			{/if}
		</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item variant="destructive" onSelect={() => (deleting = true)}>
			<Trash2Icon class="size-4" />
			Delete
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.DropdownMenu>

<Dialog.Root open={renaming} onOpenChange={(open) => (renaming = open)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Rename {noun}</Dialog.Title>
		</Dialog.Header>
		<form onsubmit={submitRename} class="flex flex-col gap-4">
			<Input bind:value={renameText} maxlength={200} placeholder="Title" />
			<Dialog.Footer>
				<Button type="submit">Save</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleting} onOpenChange={(open) => (deleting = open)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete {noun}?</Dialog.Title>
			<Dialog.Description>
				"{conversation.title || (coding ? 'New task' : 'New chat')}" will be moved to trash and
				purged after 30 days.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleting = false)}>Cancel</Button>
			<Button variant="destructive" onclick={confirmDelete}>Delete</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
