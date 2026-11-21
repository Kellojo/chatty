<script lang="ts" module>
	/** How full the model's context is after the latest reply that measured it. */
	export interface ContextUsage {
		tokens: number;
		/** The model's context window; null when it isn't known. */
		length: number | null;
		/** The model that produced the reply. */
		modelId: string;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
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
	import { registerCommands, type PaletteCommand } from '$lib/state/commands.js';
	import { isSnoozed, snoozeOptions } from '$lib/snooze.js';
	import { snoozeConversation, wakeConversation } from '$lib/snooze-actions.js';
	import AlarmClockIcon from '@lucide/svelte/icons/alarm-clock';
	import AlarmClockOffIcon from '@lucide/svelte/icons/alarm-clock-off';
	import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';
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
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LockIcon from '@lucide/svelte/icons/lock';
	import LockOpenIcon from '@lucide/svelte/icons/lock-open';
	import { formatCount } from '$lib/formats.js';

	/** The header's "⋯" menu: conversation actions, plus task details for coding tasks. */
	let {
		conversation,
		coding = null,
		environmentName = null,
		privateData = PRIVATE_DATA_OFF,
		contextUsage = null,
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
		/** Shown as a read-only meter at the foot of the menu. */
		contextUsage?: ContextUsage | null;
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

	/** Share of the context window in use, 0–100; null when the window isn't known. */
	const contextPercent = $derived(
		contextUsage?.length
			? Math.min(100, Math.round((contextUsage.tokens / contextUsage.length) * 100))
			: null
	);
	const contextTone = $derived(
		contextPercent === null || contextPercent < 75
			? 'bg-foreground/70'
			: contextPercent < 90
				? 'bg-warning'
				: 'bg-destructive'
	);
	/** A word next to the bar once it fills up, so the state doesn't rest on colour alone. */
	const contextNote = $derived(
		contextPercent === null || contextPercent < 75
			? null
			: contextPercent < 90
				? 'Filling up'
				: 'Nearly full'
	);
	const contextNoteTone = $derived(
		contextPercent !== null && contextPercent >= 90 ? 'text-destructive' : 'text-warning-foreground'
	);
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

	/** Downloads the whole chat as one Markdown file (the server sets the name). */
	function exportConversation() {
		const link = document.createElement('a');
		link.href = `/api/conversations/${conversation.id}/export`;
		link.download = '';
		link.click();
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

	// The same actions in the command palette (Mod+K), read when it opens.
	onMount(() =>
		registerCommands(() => {
			const commands: Omit<PaletteCommand, 'group'>[] = [];
			const add = (command: Omit<PaletteCommand, 'group'>) => commands.push(command);
			if (oncreatepr)
				add({
					id: 'chat:create-pr',
					label: 'Create pull request',
					icon: GitPullRequestCreateIcon,
					run: oncreatepr
				});
			if (onsettings)
				add({
					id: 'chat:coding-settings',
					label: 'Model and permissions',
					icon: SlidersHorizontalIcon,
					run: onsettings
				});
			if (onpreview)
				add({ id: 'chat:preview', label: 'Browser preview', icon: AppWindowIcon, run: onpreview });
			if (onhandoff)
				add({
					id: 'chat:handoff',
					label: 'Hand off to coding agent',
					icon: SquareTerminalIcon,
					keywords: ['t3', 'code'],
					run: onhandoff
				});
			const agentId = conversation.agentId;
			if (agentId)
				add({
					id: 'chat:open-agent',
					label: 'Open agent',
					icon: BotIcon,
					run: () => goto(resolve(`/agents/${agentId}`))
				});
			add({
				id: 'chat:settle',
				label: settled ? `Un-settle ${noun}` : `Settle ${noun}`,
				icon: settled ? ArchiveRestoreIcon : ArchiveIcon,
				keywords: ['archive', 'done'],
				run: toggleSettled
			});
			add({
				id: 'chat:read',
				label: unread ? 'Mark as read' : 'Mark as unread',
				icon: unread ? MailOpenIcon : MailIcon,
				searchOnly: true,
				run: toggleRead
			});
			if (!settled) {
				if (isSnoozed(conversation))
					add({
						id: 'chat:wake',
						label: 'Wake now',
						icon: AlarmClockOffIcon,
						keywords: ['unsnooze'],
						run: () => wakeConversation(conversation, snoozeChanged)
					});
				for (const option of snoozeOptions())
					add({
						id: `chat:snooze:${option.label}`,
						label: `Snooze: ${option.label}`,
						hint: option.when,
						icon: AlarmClockIcon,
						keywords: ['remind', 'later'],
						searchOnly: true,
						run: () => snoozeConversation(conversation, option.until, snoozeChanged)
					});
				add({
					id: 'chat:snooze-custom',
					label: 'Snooze until…',
					icon: CalendarClockIcon,
					keywords: ['remind', 'later', 'date'],
					run: () => (pickingSnooze = true)
				});
				add({
					id: 'chat:pin',
					label: conversation.pinned ? `Unpin ${noun}` : `Pin ${noun}`,
					icon: conversation.pinned ? PinOffIcon : PinIcon,
					run: togglePin
				});
			}
			add({
				id: 'chat:rename',
				label: `Rename ${noun}…`,
				icon: PencilIcon,
				keywords: ['title'],
				run: openRename
			});
			if (showPrivacy && conversation.private)
				add({
					id: 'chat:make-public',
					label: 'Make public…',
					icon: LockOpenIcon,
					keywords: ['private'],
					run: () => (confirmingPublic = true)
				});
			else if (showPrivacy && privateData.available)
				add({
					id: 'chat:make-private',
					label: 'Make private…',
					icon: LockIcon,
					run: () => (confirmingPrivate = true)
				});
			add({
				id: 'chat:delete',
				label: `Delete ${noun}…`,
				icon: Trash2Icon,
				keywords: ['remove', 'trash'],
				destructive: true,
				run: () => (deleting = true)
			});
			return commands.map((command) => ({ ...command, group: 'This chat' }));
		})
	);

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
			: 'w-60'}"
	>
		{#if contextUsage}
			<!-- Read-only: how much of the model's context the chat fills, as of the last reply. -->
			<div
				class="px-2 pt-1.5 pb-2 text-xs text-muted-foreground"
				title="As of the latest reply from {contextUsage.modelId
					.split('/')
					.pop()}{contextUsage.length
					? ''
					: '. Its context window size is unknown, so no percentage is shown.'}"
			>
				<div class="flex items-baseline justify-between gap-2">
					<span class="font-medium text-foreground/80">Context</span>
					<span class="text-foreground tabular-nums">
						{#if contextUsage.length}
							{formatCount(contextUsage.tokens)}<span class="text-muted-foreground"
								>&nbsp;/&nbsp;{formatCount(contextUsage.length)}</span
							>
						{:else}
							{formatCount(contextUsage.tokens)}&nbsp;<span class="text-muted-foreground"
								>tokens used</span
							>
						{/if}
					</span>
				</div>
				{#if contextPercent !== null}
					<div
						class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted-foreground/15"
						role="meter"
						aria-label="Context used"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={contextPercent}
						aria-valuetext="{contextPercent}% of the context window{contextNote
							? `, ${contextNote.toLowerCase()}`
							: ''}"
					>
						<div class="h-full rounded-full {contextTone}" style:width="{contextPercent}%"></div>
					</div>
					<p class="mt-1 flex justify-between gap-2 tabular-nums">
						<span class="text-foreground/70">{contextPercent}% used</span>
						{#if contextNote}
							<span class="font-medium {contextNoteTone}">{contextNote}</span>
						{/if}
					</p>
					{#if contextPercent >= 90}
						<!-- What happens next, so a full bar doesn't read as a dead end. -->
						<p class="mt-1 leading-4">Older messages will be summarised to make room.</p>
					{/if}
				{/if}
			</div>
			<DropdownMenu.Separator />
		{/if}
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
		<DropdownMenu.Item onSelect={exportConversation}>
			<DownloadIcon class="size-4" />
			Export
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
				Making it public lets models that aren't trusted with private data see this chat's history,
				including any private data it read.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (confirmingPublic = false)}>Keep private</Button>
			<Button
				variant="outline"
				class="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
				onclick={makePublic}>Make public</Button
			>
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
