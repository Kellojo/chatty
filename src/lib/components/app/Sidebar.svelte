<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { MediaQuery } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import BotIcon from '@lucide/svelte/icons/bot';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
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
	import { serverActiveChatIds } from '$lib/state/chat-status.svelte.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { invalidateWhenIdle } from '$lib/state/invalidate-when-idle.js';
	import { formatCount } from '$lib/formats.js';
	import { version } from '$lib/version.js';
	import type { Conversation } from '$lib/types.js';

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
		const { conversationIds } = (await res.json()) as { conversationIds: string[] };
		const next = new Set(conversationIds);
		let completed = false;
		for (const id of serverActiveChatIds) {
			if (!next.has(id)) completed = true;
		}
		serverActiveChatIds.clear();
		for (const id of next) serverActiveChatIds.add(id);
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
					serverActiveChatIds.add(event.conversationId);
					break;
				case 'chat.stream.finished':
					serverActiveChatIds.delete(event.conversationId);
					scheduleInvalidate();
					break;
				case 'chat.created':
				case 'conversation.updated':
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

	function settledTitle(c: Conversation): string {
		const title = c.title || 'New chat';
		if (c.settledReason !== 'auto') return title;
		const after = autoSettleDays > 0 ? ` after ${autoSettleDays} days` : '';
		return `${title}\nAuto-settled${after} of inactivity`;
	}

	let menuOpenId = $state<string | null>(null);

	async function togglePin(id: string) {
		await fetch(`/api/conversations/${id}/pin`, { method: 'POST' });
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
	<div
		class="group flex w-full items-center rounded-md text-sm {c.id === currentId
			? 'bg-accent text-accent-foreground'
			: 'hover:bg-accent/50'} {settled && c.id !== currentId ? 'text-muted-foreground' : ''}"
	>
		<a
			href={resolve(`/chat/${c.id}`)}
			class="min-w-0 flex-1 truncate px-2 py-1.5"
			title={settled ? settledTitle(c) : c.title || 'New chat'}
			onclick={handleNavigate}
		>
			{c.title || 'New chat'}
		</a>
		{#if searchResults && settled}
			<span
				class="mr-1 shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground group-hover:hidden"
				>Settled</span
			>
		{/if}
		{#if activeChats.has(c.id) || serverActiveChatIds.has(c.id)}
			<LoaderCircleIcon class="mr-1 size-3.5 shrink-0 animate-spin text-info-foreground" />
		{:else if unreadIds.includes(c.id) && page.url.pathname !== '/chat/' + c.id}
			<span class="size-2 shrink-0 rounded-full bg-info" title="New messages"></span>
		{/if}
		<span
			class="shrink-0 gap-0.5 pr-1 group-focus-within:flex group-hover:flex {menuOpenId === c.id
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
				<DropdownMenu.Content align="start" class="w-40">
					{#if !settled}
						<DropdownMenu.Item onSelect={() => void togglePin(c.id)}>
							{#if c.pinned}<PinOffIcon class="size-4" /> Unpin{:else}<PinIcon class="size-4" /> Pin{/if}
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
		{#each visibleGroups as group (group.label)}
			<p class="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
			{#each group.items as c (c.id)}
				{@render row(c)}
			{/each}
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
					{@render row(c)}
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
			class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm {page.url.pathname.startsWith(
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
			class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm {page.url.pathname.startsWith(
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
			class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm {page.url.pathname.startsWith(
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
			class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm {page.url.pathname.startsWith(
				'/usage'
			)
				? 'bg-accent text-accent-foreground'
				: 'text-muted-foreground hover:bg-accent/50'}"
			onclick={handleNavigate}
		>
			<GaugeIcon class="size-4" />
			Usage
			{#if user.role === 'admin' && requestStats}
				<span
					class="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
					title="{requestStats.total} requests all time · {requestStats.running} running"
				>
					{#if requestStats.running > 0}
						<span class="size-1.5 animate-pulse rounded-full bg-info"></span>
					{/if}
					{formatCount(requestStats.total)}
				</span>
			{/if}
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
				"{deleteTarget?.title || 'New chat'}" will be moved to trash and purged after 30 days.
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
