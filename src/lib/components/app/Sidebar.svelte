<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { MediaQuery } from 'svelte/reactivity';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import BotIcon from '@lucide/svelte/icons/bot';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CodeIcon from '@lucide/svelte/icons/code';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MailOpenIcon from '@lucide/svelte/icons/mail-open';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { authClient } from '$lib/auth-client.js';
	import { activeChats } from '$lib/state/active-chats.svelte.js';
	import { serverActiveChats } from '$lib/state/chat-status.svelte.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { invalidateWhenIdle } from '$lib/state/invalidate-when-idle.js';
	import { formatCount } from '$lib/formats.js';
	import { version } from '$lib/version.js';
	import type { Conversation } from '$lib/types.js';
	import type { CodingTaskStatus } from '$lib/coding-environments.js';
	import { CODING_PR_STATE_STYLE } from '$lib/coding-status.js';
	import CodingRunTimer from './CodingRunTimer.svelte';
	import PullRequestIcon from './PullRequestIcon.svelte';
	import SidebarPlanLimits from './usage/SidebarPlanLimits.svelte';

	let {
		user,
		conversations,
		hasMore,
		unreadIds,
		settledCount,
		autoSettleDays,
		onclose
	}: {
		user: { name: string; email: string; image: string | null; role: string };
		conversations: Conversation[];
		hasMore: boolean;
		unreadIds: string[];
		settledCount: number;
		autoSettleDays: number;
		onclose: () => void;
	} = $props();

	const isMobile = new MediaQuery('(max-width: 767px)');

	function handleNavigate() {
		if (isMobile.current) onclose();
	}

	let extraState = $state<{ base: Conversation[]; extra: Conversation[]; hasMore: boolean }>(
		(() => ({ base: conversations, extra: [], hasMore }))()
	);
	let loadingMore = $state(false);

	const extras = $derived(extraState.base === conversations ? extraState.extra : []);
	const hasMorePages = $derived(extraState.base === conversations ? extraState.hasMore : hasMore);

	function observeSentinel(node: HTMLElement) {
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) void loadMore();
		});
		observer.observe(node);
		return () => observer.disconnect();
	}

	async function loadMore() {
		if (loadingMore || !hasMorePages) return;
		loadingMore = true;
		try {
			const base = conversations;
			const offset = base.length + extras.length;
			const res = await fetch(`/api/conversations?offset=${offset}`);
			if (!res.ok) return;
			const data = (await res.json()) as { conversations: Conversation[]; hasMore: boolean };
			const known = new Set([...base, ...extras].map((c) => c.id));
			extraState = {
				base,
				extra: [...extras, ...data.conversations.filter((c) => !known.has(c.id))],
				hasMore: data.hasMore
			};
		} finally {
			loadingMore = false;
		}
	}

	const allConversations = $derived([...conversations, ...extras]);

	const SETTLED_OPEN_KEY = 'chatty.sidebar.settledOpen';
	let settledOpen = $state(false);
	let settledItems = $state<Conversation[] | null>(null);
	let settledHasMore = $state(false);
	let settledLoading = $state(false);

	async function loadSettled(reset: boolean) {
		if (settledLoading && !reset) return;
		settledLoading = true;
		try {
			const offset = reset ? 0 : (settledItems?.length ?? 0);
			const res = await fetch(`/api/conversations/settled?offset=${offset}`);
			if (!res.ok) return;
			const data = (await res.json()) as { conversations: Conversation[]; hasMore: boolean };
			const previous = reset ? [] : (settledItems ?? []);
			const known = new Set(previous.map((c) => c.id));
			settledItems = [...previous, ...data.conversations.filter((c) => !known.has(c.id))];
			settledHasMore = data.hasMore;
		} finally {
			settledLoading = false;
		}
	}

	function toggleSettledShelf() {
		settledOpen = !settledOpen;
		try {
			localStorage.setItem(SETTLED_OPEN_KEY, settledOpen ? '1' : '0');
		} catch {
			// storage unavailable; the shelf just won't remember its state
		}
		if (settledOpen) void loadSettled(true);
	}

	/** Refreshes everything that depends on settled state after a change. */
	async function refreshSettled() {
		if (settledOpen) void loadSettled(true);
		else settledItems = null;
		if (searchResults) void search();
	}

	let query = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);
	let searchResults = $state<Conversation[] | null>(null);
	let renameTarget = $state<Conversation | null>(null);
	let renameText = $state('');
	let deleteTarget = $state<Conversation | null>(null);
	let agentStats = $state<{ running: number; total: number } | null>(null);
	let memoryCount = $state<number | null>(null);
	let skillCount = $state<number | null>(null);
	let requestStats = $state<{ running: number; total: number } | null>(null);

	function refreshAgentStats() {
		fetch('/api/agents/stats')
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (d) agentStats = d;
			})
			.catch(() => {});
	}

	function refreshMemoryCount() {
		fetch('/api/memory/stats')
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (d) memoryCount = d.count;
			})
			.catch(() => {});
	}

	function refreshSkillCount() {
		fetch('/api/skills/stats')
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (d) skillCount = d.count;
			})
			.catch(() => {});
	}

	function refreshRequestCount() {
		fetch('/api/proxy-requests/stats')
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (d) requestStats = { running: d.running ?? 0, total: d.count };
			})
			.catch(() => {});
	}

	async function refreshActiveChats() {
		const res = await fetch('/api/chat/active');
		if (!res.ok) return;
		const { streams } = (await res.json()) as {
			streams: Array<{ conversationId: string; startedAt: number }>;
		};
		const next = new Map(streams.map((s) => [s.conversationId, s.startedAt]));
		let completed = false;
		for (const id of serverActiveChats.keys()) {
			if (!next.has(id)) completed = true;
		}
		serverActiveChats.clear();
		for (const [id, startedAt] of next) serverActiveChats.set(id, startedAt);
		if (completed) await invalidateWhenIdle();
	}

	function onGlobalKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			searchInput?.focus();
			searchInput?.select();
		}
	}

	onMount(() => {
		try {
			settledOpen = localStorage.getItem(SETTLED_OPEN_KEY) === '1';
		} catch {
			settledOpen = false;
		}
		if (settledOpen) void loadSettled(true);
		refreshAgentStats();
		refreshMemoryCount();
		refreshSkillCount();
		if (user.role === 'admin') refreshRequestCount();
		refreshActiveChats().catch(() => {});
		let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
		const scheduleInvalidate = () => {
			if (invalidateTimer) return;
			invalidateTimer = setTimeout(() => {
				invalidateTimer = null;
				void invalidateWhenIdle();
			}, 200);
		};
		const offEvents = onServerEvent((event) => {
			switch (event.type) {
				case 'chat.stream.started':
					serverActiveChats.set(event.conversationId, event.startedAt ?? Date.now());
					break;
				case 'chat.stream.finished':
					serverActiveChats.delete(event.conversationId);
					scheduleInvalidate();
					break;
				case 'chat.created':
				case 'conversation.updated':
				case 'coding.task.updated':
					scheduleInvalidate();
					break;
				case 'conversation.settle_changed':
					scheduleInvalidate();
					void refreshSettled();
					break;
				case 'agent.run.started':
				case 'agent.run.finished':
					refreshAgentStats();
					break;
				case 'proxy.request.started':
				case 'proxy.request.finished':
					if (user.role === 'admin') refreshRequestCount();
					break;
				case 'memory.changed':
					refreshMemoryCount();
					break;
				case 'skills.changed':
					refreshSkillCount();
					break;
			}
		});
		const offResync = onServerEventResync(() => {
			refreshAgentStats();
			refreshMemoryCount();
			refreshSkillCount();
			if (user.role === 'admin') refreshRequestCount();
			refreshActiveChats().catch(() => {});
		});
		return () => {
			offEvents();
			offResync();
			if (invalidateTimer) clearTimeout(invalidateTimer);
		};
	});

	const currentId = $derived(page.params.id ?? '');

	const initials = $derived(
		user.name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? '')
			.join('')
	);

	type Group = { label: string; items: Conversation[] };

	function groupByDate(items: Conversation[]): Group[] {
		const now = new Date();
		const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const day = 24 * 60 * 60 * 1000;
		const groups: Group[] = [
			{ label: 'Pinned', items: [] },
			{ label: 'Today', items: [] },
			{ label: 'Yesterday', items: [] },
			{ label: 'This week', items: [] },
			{ label: 'Older', items: [] }
		];
		for (const c of items) {
			if (c.pinned) groups[0].items.push(c);
			else if (c.updatedAt >= startOfDay) groups[1].items.push(c);
			else if (c.updatedAt >= startOfDay - day) groups[2].items.push(c);
			else if (c.updatedAt >= startOfDay - 7 * day) groups[3].items.push(c);
			else groups[4].items.push(c);
		}
		return groups.filter((g) => g.items.length > 0);
	}

	const visibleGroups = $derived(groupByDate(searchResults ?? allConversations));

	// Flattened into one keyed list (group headers + rows) so `animate:flip`
	// can animate rows moving between groups, not just within one.
	type ListEntry =
		| { kind: 'header'; key: string; label: string }
		| { kind: 'row'; key: string; conversation: Conversation };
	const visibleEntries = $derived(
		visibleGroups.flatMap((g): ListEntry[] => [
			{ kind: 'header', key: `group:${g.label}`, label: g.label },
			...g.items.map((c): ListEntry => ({ kind: 'row', key: c.id, conversation: c }))
		])
	);

	const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
	const flipDuration = $derived(reducedMotion.current ? 0 : 200);
	const fadeDuration = $derived(reducedMotion.current ? 0 : 150);

	async function search() {
		const q = query.trim();
		if (!q) {
			searchResults = null;
			return;
		}
		const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(q)}`);
		if (res.ok) {
			searchResults = ((await res.json()) as { conversations: Conversation[] }).conversations;
		}
	}

	async function newChat() {
		query = '';
		searchResults = null;
		goto(resolve('/'));
	}

	async function setSettled(c: Conversation, settled: boolean, undo?: { repin: boolean }) {
		const res = await fetch(`/api/conversations/${c.id}/settle`, {
			method: settled ? 'POST' : 'DELETE'
		});
		if (!res.ok) {
			toast.error(settled ? 'Failed to settle conversation' : 'Failed to un-settle conversation');
			return;
		}
		// Settling unpins, so undoing a settle restores the pin.
		if (undo?.repin) await fetch(`/api/conversations/${c.id}/pin`, { method: 'POST' });
		await invalidateAll();
		await refreshSettled();
		if (undo) return;
		const repin = settled && c.pinned;
		toast.success(settled ? 'Conversation settled' : 'Conversation un-settled', {
			action: { label: 'Undo', onClick: () => void setSettled(c, !settled, { repin }) }
		});
	}

	function displayTitle(c: Conversation): string {
		return c.title || (c.coding ? 'New task' : 'New chat');
	}

	/** Second line of a chat row: the model it talks to, without the vendor prefix. */
	function chatSource(c: Conversation): string {
		return c.modelId?.split('/').pop() || 'Chat';
	}

	function settledTitle(c: Conversation): string {
		const title = displayTitle(c);
		if (c.settledReason !== 'auto') return title;
		const after = autoSettleDays > 0 ? ` after ${autoSettleDays} days` : '';
		return `${title}\nAuto-settled${after} of inactivity`;
	}

	/** Status words shown under a coding task's title; working/idle stay quiet there. */
	const CODING_STATUS: Partial<Record<CodingTaskStatus, { label: string; tone: string }>> = {
		awaiting_input: { label: 'Needs you', tone: 'text-amber-700 dark:text-amber-400' },
		failed: { label: 'Failed', tone: 'text-destructive' },
		interrupted: { label: 'Stopped', tone: 'text-muted-foreground' }
	};

	/**
	 * One inbox-style state for every row, chat or coding task. Anything but
	 * `working` and `idle` asks the user to look at the conversation.
	 */
	type RowState = 'working' | 'needs-you' | 'failed' | 'unread' | 'idle';

	const ROW_STATE_LABEL: Record<RowState, string | null> = {
		working: 'Working',
		'needs-you': 'Needs you',
		failed: 'Failed',
		unread: 'New reply',
		idle: null
	};

	function rowState(c: Conversation): RowState {
		const status = c.coding?.status;
		if (
			activeChats.has(c.id) ||
			serverActiveChats.has(c.id) ||
			status === 'running' ||
			status === 'starting'
		)
			return 'working';
		if (status === 'awaiting_input') return 'needs-you';
		// Failures, like replies, stop asking for attention once they've been seen.
		const unread = unreadIds.includes(c.id) && page.url.pathname !== `/chat/${c.id}`;
		if (!unread) return 'idle';
		return status === 'failed' ? 'failed' : 'unread';
	}

	function rowTitle(c: Conversation, state: RowState): string {
		const title = c.settledAt !== null ? settledTitle(c) : displayTitle(c);
		const details = [
			c.coding ? 'Coding task' : null,
			c.coding?.projectTitle,
			ROW_STATE_LABEL[state] ?? (c.coding ? CODING_STATUS[c.coding.status]?.label : null)
		].filter(Boolean);
		return details.length ? `${title}\n${details.join(' · ')}` : title;
	}

	let menuOpenId = $state<string | null>(null);

	async function togglePin(id: string) {
		await fetch(`/api/conversations/${id}/pin`, { method: 'POST' });
		await invalidateAll();
	}

	async function setRead(c: Conversation, read: boolean) {
		const res = await fetch(`/api/conversations/${c.id}/read`, {
			method: read ? 'POST' : 'DELETE'
		}).catch(() => null);
		if (!res?.ok) {
			toast.error(read ? 'Failed to mark as read' : 'Failed to mark as unread');
			return;
		}
		await invalidateAll();
	}

	function openRename(c: Conversation) {
		renameTarget = c;
		renameText = c.title;
	}

	async function submitRename(event: SubmitEvent) {
		event.preventDefault();
		if (!renameTarget) return;
		await fetch(`/api/conversations/${renameTarget.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: renameText.trim() })
		});
		renameTarget = null;
		await invalidateAll();
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		const id = deleteTarget.id;
		deleteTarget = null;
		const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
		if (res.ok) {
			toast.success('Conversation deleted');
			if (currentId === id) await goto(resolve('/'));
			await invalidateAll();
		} else {
			toast.error('Failed to delete conversation');
		}
	}

	async function signOut() {
		await authClient.signOut();
		goto(resolve('/login'));
	}
</script>

{#snippet row(c: Conversation)}
	{@const settled = c.settledAt !== null}
	{@const state = rowState(c)}
	{@const attention =
		!settled && (state === 'needs-you' || state === 'failed' || state === 'unread')}
	{@const codingStatus = c.coding ? CODING_STATUS[c.coding.status] : undefined}
	{@const stateLabel = ROW_STATE_LABEL[state]}
	{@const runStartedAt =
		state !== 'working'
			? null
			: c.coding
				? c.coding.runStartedAt
				: (serverActiveChats.get(c.id) ?? null)}
	<div
		class="group mb-0.5 flex w-full items-start rounded-md text-sm {c.id === currentId
			? 'bg-accent text-accent-foreground'
			: 'hover:bg-accent/50'} {settled && c.id !== currentId ? 'text-muted-foreground' : ''}"
	>
		<a
			href={resolve(`/chat/${c.id}`)}
			class="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
			title={rowTitle(c, state)}
			onclick={handleNavigate}
		>
			{#if c.coding}
				<CodeIcon class="mt-[3px] size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span class="sr-only">Coding task:</span>
			{:else}
				<MessageCircleIcon
					class="mt-[3px] size-3.5 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
				<span class="sr-only">Chat:</span>
			{/if}
			<!-- Chats and coding tasks share one layout: title + state mark, then where
			     it runs (project or model), its timer or status, and the PR. -->
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="flex min-w-0 items-center gap-2 leading-5">
					<span
						class="min-w-0 flex-1 truncate {attention
							? 'font-semibold'
							: (state === 'idle' || state === 'working') && !settled && c.id !== currentId
								? 'text-foreground/70 group-focus-within:text-foreground group-hover:text-foreground'
								: ''}">{displayTitle(c)}</span
					>
					{#if state === 'working' || attention}
						<!-- Gives way to the row actions on hover. -->
						<span
							class="size-3 shrink-0 items-center justify-center group-focus-within:hidden group-hover:hidden {menuOpenId ===
							c.id
								? 'hidden'
								: 'flex'}"
							aria-hidden="true"
						>
							{#if state === 'working'}
								<LoaderCircleIcon
									class="size-3 animate-spin text-info motion-reduce:animate-none"
								/>
							{:else}
								<span
									class="size-2 rounded-full {state === 'needs-you'
										? 'bg-amber-700 dark:bg-amber-400'
										: state === 'failed'
											? 'bg-destructive'
											: 'bg-success'}"
								></span>
							{/if}
						</span>
					{/if}
				</span>
				<span class="flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
					<span class="sr-only">,</span>
					<span class="truncate">{c.coding ? c.coding.projectTitle : chatSource(c)}</span>
					{#if runStartedAt}
						<span class="shrink-0" aria-hidden="true">·</span>
						<span class="shrink-0" aria-hidden="true">
							<CodingRunTimer startedAt={runStartedAt} dot={false} />
						</span>
					{:else if state === 'working' && !c.coding}
						<span class="shrink-0" aria-hidden="true">·</span>
						<span class="shrink-0" aria-hidden="true">Working</span>
					{/if}
					{#if codingStatus}
						<span class="shrink-0" aria-hidden="true">·</span>
						<span class="shrink-0 {codingStatus.tone}">{codingStatus.label}</span>
					{/if}
					{#if c.coding?.pullRequest}
						{@const prState = c.coding.pullRequest.state}
						{@const prLabel = prState
							? `Pull request ${CODING_PR_STATE_STYLE[prState].label.toLowerCase()}`
							: 'Has a pull request'}
						<span class="ml-auto inline-flex shrink-0 items-center pl-2" title={prLabel}>
							<PullRequestIcon state={prState} class="size-3" />
							<span class="sr-only">, {prLabel}</span>
						</span>
					{/if}
				</span>
			</span>
			{#if stateLabel && stateLabel !== codingStatus?.label}
				<span class="sr-only">, {stateLabel}</span>
			{/if}
		</a>
		{#if searchResults && settled}
			<span
				class="mt-2 mr-1 shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground group-hover:hidden"
				>Settled</span
			>
		{/if}
		<span
			class="mt-1.5 shrink-0 gap-0.5 pr-1 group-focus-within:flex group-hover:flex {menuOpenId ===
			c.id
				? 'flex'
				: 'hidden'}"
		>
			<button
				class="rounded p-1 text-muted-foreground hover:text-foreground"
				title={settled ? 'Un-settle' : 'Settle (hide from sidebar)'}
				aria-label={settled ? 'Un-settle' : 'Settle'}
				onclick={(e) => {
					e.stopPropagation();
					void setSettled(c, !settled);
				}}
			>
				{#if settled}
					<ArchiveRestoreIcon class="size-4" />
				{:else}
					<ArchiveIcon class="size-4" />
				{/if}
			</button>
			<DropdownMenu.Root
				open={menuOpenId === c.id}
				onOpenChange={(open) => (menuOpenId = open ? c.id : null)}
			>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							class="rounded p-1 text-muted-foreground hover:text-foreground"
							title="More actions"
							aria-label="More actions"
						>
							<EllipsisIcon class="size-4" />
						</button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-44">
					{#if !settled}
						<DropdownMenu.Item onSelect={() => void togglePin(c.id)}>
							{#if c.pinned}<PinOffIcon class="size-4" /> Unpin{:else}<PinIcon class="size-4" /> Pin{/if}
						</DropdownMenu.Item>
					{/if}
					{#if state !== 'working' && state !== 'needs-you' && c.id !== currentId}
						{@const read = state === 'idle'}
						<DropdownMenu.Item onSelect={() => void setRead(c, !read)}>
							{#if read}
								<MailIcon class="size-4" /> Mark as unread
							{:else}
								<MailOpenIcon class="size-4" /> Mark as read
							{/if}
						</DropdownMenu.Item>
					{/if}
					<DropdownMenu.Item onSelect={() => openRename(c)}>
						<PencilIcon class="size-4" />
						Rename
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" onSelect={() => (deleteTarget = c)}>
						<Trash2Icon class="size-4" />
						Delete
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</span>
	</div>
{/snippet}

<svelte:window onkeydown={onGlobalKeydown} />

<aside class="flex h-full w-72 shrink-0 flex-col border-r bg-muted/30">
	<div class="flex items-center justify-between gap-2 p-3">
		<div class="flex min-w-0 items-center gap-2">
			<svg
				viewBox="0 0 24 24"
				class="brand-icon size-5 shrink-0 rounded-md bg-foreground text-background"
				aria-hidden="true"
			>
				<g
					transform="translate(3.5 3.5) scale(0.7083)"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M5.5 6.5l5 5.5-5 5.5" />
					<path class="brand-cursor" d="M12.5 18h6" />
				</g>
			</svg>
			<a
				href="https://github.com/Kellojo/chatty"
				target="_blank"
				rel="noopener noreferrer"
				class="px-1 text-sm font-semibold hover:underline"
				title="GitHub repository"
			>
				Chatty
			</a>
			<span class="text-xs text-muted-foreground">v{version}</span>
		</div>
		<Button variant="ghost" size="sm" onclick={() => onclose()} aria-label="Close sidebar">
			<XIcon class="size-4" />
		</Button>
	</div>

	<div class="px-3 pb-2">
		<div class="relative">
			<Input
				bind:ref={searchInput}
				placeholder="Search conversations…"
				bind:value={query}
				oninput={search}
				class="h-8 pr-8 text-sm"
			/>
			<button
				type="button"
				class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				onclick={() => {
					newChat();
					handleNavigate();
				}}
				title="New chat"
				aria-label="New chat"
			>
				<PlusIcon class="size-4" />
			</button>
		</div>
	</div>
	<nav
		class="flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)] px-2 pb-2"
	>
		{#each visibleEntries as entry (entry.key)}
			<div
				animate:flip={{ duration: flipDuration, easing: cubicOut }}
				transition:fade={{ duration: fadeDuration }}
			>
				{#if entry.kind === 'header'}
					<p class="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">{entry.label}</p>
				{:else}
					{@render row(entry.conversation)}
				{/if}
			</div>
		{:else}
			<p class="px-2 pt-4 text-sm text-muted-foreground">
				{searchResults
					? 'No matches.'
					: settledCount > 0
						? 'No active conversations.'
						: 'No conversations yet.'}
			</p>
		{/each}
		{#if !searchResults && hasMorePages}
			<div {@attach observeSentinel} class="flex justify-center py-2">
				{#if loadingMore}
					<LoaderCircleIcon class="size-4 animate-spin text-muted-foreground" />
				{/if}
			</div>
		{/if}
		{#if !searchResults && (settledCount > 0 || (settledItems?.length ?? 0) > 0)}
			<button
				type="button"
				class="mt-3 flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground"
				aria-expanded={settledOpen}
				onclick={toggleSettledShelf}
			>
				<ChevronRightIcon class="size-3.5 transition-transform {settledOpen ? 'rotate-90' : ''}" />
				Settled ({settledCount})
			</button>
			{#if settledOpen}
				{#each settledItems ?? [] as c (c.id)}
					<div
						animate:flip={{ duration: flipDuration, easing: cubicOut }}
						transition:fade={{ duration: fadeDuration }}
					>
						{@render row(c)}
					</div>
				{:else}
					{#if settledLoading}
						<div class="flex justify-center py-2">
							<LoaderCircleIcon class="size-4 animate-spin text-muted-foreground" />
						</div>
					{/if}
				{/each}
				{#if settledHasMore}
					<button
						type="button"
						class="flex w-full items-center justify-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
						disabled={settledLoading}
						onclick={() => loadSettled(false)}
					>
						{#if settledLoading}
							<LoaderCircleIcon class="size-3.5 animate-spin" />
						{/if}
						Show more
					</button>
				{/if}
			{/if}
		{/if}
	</nav>

	<div class="px-2 pt-2 pb-2">
		<p class="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">Workspace</p>
		<a
			href={resolve('/agents')}
			class="mb-0.5 flex items-center gap-2 rounded-md px-2 py-2 text-sm {page.url.pathname.startsWith(
				'/agents'
			)
				? 'bg-accent text-accent-foreground'
				: 'text-muted-foreground hover:bg-accent/50'}"
			onclick={handleNavigate}
		>
			<BotIcon class="size-4" />
			Agents
			{#if agentStats}
				<span
					class="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
					title="{agentStats.running} running of {agentStats.total} agents"
				>
					{#if agentStats.running > 0}
						<span class="size-1.5 animate-pulse rounded-full bg-info"></span>
					{/if}
					{agentStats.running}/{agentStats.total}
				</span>
			{/if}
		</a>
		<a
			href={resolve('/memory')}
			class="mb-0.5 flex items-center gap-2 rounded-md px-2 py-2 text-sm {page.url.pathname.startsWith(
				'/memory'
			)
				? 'bg-accent text-accent-foreground'
				: 'text-muted-foreground hover:bg-accent/50'}"
			onclick={handleNavigate}
		>
			<BrainIcon class="size-4" />
			Memory
			{#if memoryCount !== null}
				<span
					class="ml-auto text-xs text-muted-foreground tabular-nums"
					title="{memoryCount} {memoryCount === 1 ? 'memory' : 'memories'}">{memoryCount}</span
				>
			{/if}
		</a>
		<a
			href={resolve('/skills')}
			class="mb-0.5 flex items-center gap-2 rounded-md px-2 py-2 text-sm {page.url.pathname.startsWith(
				'/skills'
			)
				? 'bg-accent text-accent-foreground'
				: 'text-muted-foreground hover:bg-accent/50'}"
			onclick={handleNavigate}
		>
			<SparklesIcon class="size-4" />
			Skills
			{#if skillCount !== null}
				<span
					class="ml-auto text-xs text-muted-foreground tabular-nums"
					title="{skillCount} {skillCount === 1 ? 'skill' : 'skills'}">{skillCount}</span
				>
			{/if}
		</a>
		<a
			href={resolve('/usage')}
			class="mb-0.5 flex items-center gap-2 rounded-md px-2 py-2 text-sm {page.url.pathname.startsWith(
				'/usage'
			)
				? 'bg-accent text-accent-foreground'
				: 'text-muted-foreground hover:bg-accent/50'}"
			onclick={handleNavigate}
		>
			<GaugeIcon class="size-4" />
			Usage
			<span class="ml-auto inline-flex items-center gap-3">
				<!-- The subscription limit closest to its cap. -->
				<SidebarPlanLimits />
				{#if user.role === 'admin' && requestStats}
					<span
						class="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
						title="{requestStats.total} requests all time · {requestStats.running} running"
					>
						{#if requestStats.running > 0}
							<span class="size-1.5 animate-pulse rounded-full bg-info"></span>
						{/if}
						{formatCount(requestStats.total)}
					</span>
				{/if}
			</span>
		</a>
	</div>

	<div class="flex items-center justify-between gap-2 border-t p-3">
		<div class="flex min-w-0 items-center gap-2">
			{#if user.image}
				<img src={user.image} alt="" class="size-7 shrink-0 rounded-full object-cover" />
			{:else if initials}
				<span
					class="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
				>
					{initials}
				</span>
			{/if}
			<span class="min-w-0 truncate text-sm" title={user.email}>{user.name}</span>
		</div>
		<div class="flex shrink-0 gap-1">
			<Button
				variant="ghost"
				size="icon"
				href={resolve('/settings')}
				aria-label="Settings"
				title="Settings"
				onclick={handleNavigate}
			>
				<SettingsIcon class="size-4" />
			</Button>
			<Button variant="ghost" size="icon" onclick={signOut} aria-label="Sign out" title="Sign out">
				<LogOutIcon class="size-4" />
			</Button>
		</div>
	</div>
</aside>

<Dialog.Root open={renameTarget !== null} onOpenChange={(open) => !open && (renameTarget = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Rename conversation</Dialog.Title>
		</Dialog.Header>
		<form onsubmit={submitRename} class="flex flex-col gap-4">
			<Input bind:value={renameText} maxlength={200} placeholder="Conversation title" />
			<Dialog.Footer>
				<Button type="submit">Save</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete conversation?</Dialog.Title>
			<Dialog.Description>
				"{deleteTarget ? displayTitle(deleteTarget) : ''}" will be moved to trash and purged after
				30 days.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
			<Button variant="destructive" onclick={confirmDelete}>Delete</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.brand-cursor {
		animation: brand-blink 1.06s steps(1) infinite;
	}
	@keyframes brand-blink {
		0%,
		53% {
			opacity: 1;
		}
		54%,
		100% {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.brand-cursor {
			animation: none;
		}
	}
</style>
