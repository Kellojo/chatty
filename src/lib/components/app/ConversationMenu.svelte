<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { Conversation, PrivateDataStatus } from '$lib/types.js';
	import { PRIVATE_DATA_OFF } from '$lib/private-data.js';
	import type { CodingConversation } from '$lib/coding-environments.js';
	import CodingTaskDetails from './CodingTaskDetails.svelte';
	import MakePrivateDialog from './MakePrivateDialog.svelte';
	import SnoozeMenuItems from './SnoozeMenuItems.svelte';
	import SnoozeDialog from './SnoozeDialog.svelte';
	import { markedUnread, setConversationRead } from './marked-unread.svelte.js';
	import { page } from '$app/state';
	import { MediaQuery } from 'svelte/reactivity';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MailOpenIcon from '@lucide/svelte/icons/mail-open';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import GitPullRequestCreateIcon from '@lucide/svelte/icons/git-pull-request-create';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import BotIcon from '@lucide/svelte/icons/bot';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import LockIcon from '@lucide/svelte/icons/lock';
	import LockOpenIcon from '@lucide/svelte/icons/lock-open';

	/** The header's "⋯" menu: conversation actions, plus task details for coding tasks. */
	let {
		conversation,
		coding = null,
		environmentName = null,
		privateData = PRIVATE_DATA_OFF,
		onupdated,
		onhandoff,
		oncreatepr,
		onsettings,
		onpreview
	}: {
		conversation: Conversation;
		coding?: CodingConversation | null;
		environmentName?: string | null;
		/** The app shell's private-data switches: the privacy items follow them. */
		privateData?: PrivateDataStatus;
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

	const isPhone = new MediaQuery('(max-width: 639px)');

	let renaming = $state(false);
	let renameText = $state('');
	let deleting = $state(false);
	let pickingSnooze = $state(false);
	let confirmingPublic = $state(false);
	let confirmingPrivate = $state(false);
	let savingPrivacy = $state(false);

	// Coding chats run on a T3 machine and can never be private.
	const showPrivacy = $derived(privateData.enabled && !coding && !conversation.coding);
	const isAdmin = $derived((page.data.user as { role?: string } | undefined)?.role === 'admin');

	async function makePublic() {
		confirmingPublic = false;
		savingPrivacy = true;
		try {
			const res = await fetch(`/api/conversations/${conversation.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ private: false, confirm: true })
			}).catch(() => null);
			if (!res?.ok) {
				const data = (await res?.json().catch(() => null)) as { message?: string } | null;
				toast.error(data?.message ?? 'Failed to make the chat public');
				return;
			}
			const { conversation: updated } = (await res.json()) as { conversation: Conversation };
			onupdated(updated);
			toast.success('This chat is now public');
			await invalidateAll();
		} finally {
			savingPrivacy = false;
		}
	}

	async function madePrivate(updated: Conversation | undefined) {
		confirmingPrivate = false;
		if (updated) onupdated(updated);
		await invalidateAll();
	}

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
			pinned: settled ? conversation.pinned : false,
			snoozedUntil: settled ? conversation.snoozedUntil : null
		});
		toast.success(
			settled
				? `${coding ? 'Task' : 'Conversation'} un-settled`
				: `${coding ? 'Task' : 'Conversation'} settled`
		);
		await invalidateAll();
	}

	// The open chat reads itself, so it only counts as unread when marked so here
	// or from the sidebar.
	const unread = $derived(
		markedUnread.id === conversation.id &&
			((page.data.unreadIds as string[] | undefined)?.includes(conversation.id) ?? false)
	);

	async function toggleRead() {
		const read = unread;
		if (!(await setConversationRead(conversation.id, read, conversation.id))) {
			toast.error(read ? 'Failed to mark as read' : 'Failed to mark as unread');
			return;
		}
		await invalidateAll();
	}

	async function snoozeChanged(until: number | null) {
		onupdated({
			...conversation,
			snoozedUntil: until,
			pinned: until !== null ? false : conversation.pinned
		});
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
		class="max-h-(--bits-dropdown-menu-content-available-height) max-w-[calc(100vw-1rem)] {coding
			? 'w-80'
			: 'w-52'}"
	>
		<!--
			Phone-only actions (the header has no room for them) lead the menu. Not
			rendered on wider screens, where hidden items would still take arrow-key focus.
		-->
		{#if isPhone.current}
			{#if oncreatepr}
				<DropdownMenu.Item onSelect={oncreatepr}>
					<GitPullRequestCreateIcon class="size-4" />
					Create pull request
				</DropdownMenu.Item>
			{/if}
			{#if onsettings}
				<DropdownMenu.Item onSelect={onsettings}>
					<SlidersHorizontalIcon class="size-4" />
					Model and permissions
				</DropdownMenu.Item>
			{/if}
			{#if onpreview}
				<DropdownMenu.Item onSelect={onpreview}>
					<AppWindowIcon class="size-4" />
					Browser preview
				</DropdownMenu.Item>
			{/if}
			{#if onhandoff}
				<DropdownMenu.Item onSelect={onhandoff}>
					<SquareTerminalIcon class="size-4" />
					Hand off to coding agent
				</DropdownMenu.Item>
			{/if}
			{#if oncreatepr || onsettings || onpreview || onhandoff}
				<DropdownMenu.Separator />
			{/if}
		{/if}

		{#if coding}
			<CodingTaskDetails {coding} {environmentName} />
			<DropdownMenu.Separator />
		{/if}
		{#if conversation.agentId}
			<!-- The chat runs as (or was started by) an agent: jump to its setup. -->
			<DropdownMenu.Item onSelect={() => goto(resolve(`/agents/${conversation.agentId}`))}>
				<BotIcon class="size-4" />
				Open agent
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
		{/if}
		<DropdownMenu.Item onSelect={toggleSettled}>
			{#if settled}
				<ArchiveRestoreIcon class="size-4" /> Un-settle
			{:else}
				<ArchiveIcon class="size-4" /> Settle
			{/if}
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={toggleRead}>
			{#if unread}
				<MailOpenIcon class="size-4" /> Mark as read
			{:else}
				<MailIcon class="size-4" /> Mark as unread
			{/if}
		</DropdownMenu.Item>
		<SnoozeMenuItems
			{conversation}
			onchanged={snoozeChanged}
			oncustom={() => (pickingSnooze = true)}
		/>
		{#if !settled}
			<DropdownMenu.Item onSelect={togglePin}>
				{#if conversation.pinned}
					<PinOffIcon class="size-4" /> Unpin
				{:else}
					<PinIcon class="size-4" /> Pin
				{/if}
			</DropdownMenu.Item>
		{/if}
		<DropdownMenu.Item onSelect={openRename}>
			<PencilIcon class="size-4" />
			Rename
		</DropdownMenu.Item>
		{#if showPrivacy}
			{#if conversation.private}
				<DropdownMenu.Item disabled={savingPrivacy} onSelect={() => (confirmingPublic = true)}>
					<LockOpenIcon class="size-4" />
					Make public…
				</DropdownMenu.Item>
			{:else if privateData.available}
				<DropdownMenu.Item disabled={savingPrivacy} onSelect={() => (confirmingPrivate = true)}>
					<LockIcon class="size-4" />
					Make private…
				</DropdownMenu.Item>
			{:else}
				<!-- No trusted provider yet: say why, and (for admins) where to set one up. -->
				<DropdownMenu.Item
					disabled={!isAdmin}
					class="items-start"
					title="Private chats need a provider trusted with private data"
					onSelect={() => goto(resolve('/settings/providers'))}
				>
					<LockIcon class="mt-0.5 size-4" />
					<span class="flex min-w-0 flex-col">
						<span>Make private</span>
						<span class="text-xs font-normal text-muted-foreground">
							{isAdmin
								? 'Trust a provider in Settings → Providers first'
								: 'Needs a provider trusted with private data'}
						</span>
					</span>
				</DropdownMenu.Item>
			{/if}
		{/if}
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

<SnoozeDialog
	conversation={pickingSnooze ? conversation : null}
	onclose={() => (pickingSnooze = false)}
	onchanged={snoozeChanged}
/>

<Dialog.Root open={confirmingPublic} onOpenChange={(open) => (confirmingPublic = open)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Make this chat public?</Dialog.Title>
			<Dialog.Description>
				Anything already sent in this chat can't be recalled. Making it public lets untrusted
				models, and tools that send data outside Chatty, see this chat's history, including any
				private data it read.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (confirmingPublic = false)}>Keep private</Button>
			<Button onclick={makePublic}>Make public</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<MakePrivateDialog
	targets={confirmingPrivate ? [conversation] : null}
	admin={isAdmin}
	onclose={() => (confirmingPrivate = false)}
	ondone={({ conversation: updated }) => madePrivate(updated)}
/>

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
