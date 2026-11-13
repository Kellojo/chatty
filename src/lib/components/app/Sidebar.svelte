<script lang="ts">
	import { onMount, untrack } from 'svelte';
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
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleDotDashedIcon from '@lucide/svelte/icons/circle-dot-dashed';
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
	import KeyboardIcon from '@lucide/svelte/icons/keyboard';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { signOutToLogin } from '$lib/auth-client.js';
	import { syncAnimation } from '$lib/sync-animation.js';
	import UserAvatar from './UserAvatar.svelte';
	import { activeChats } from '$lib/state/active-chats.svelte.js';
	import { serverActiveChats } from '$lib/state/chat-status.svelte.js';
	import { onServerEvent, onServerEventResync } from '$lib/state/events.svelte.js';
	import { invalidateWhenIdle, scheduleInvalidate } from '$lib/state/invalidate-when-idle.js';
	import { CONVERSATIONS_KEY } from '$lib/load-keys.js';
	import { shortcutLabel } from '$lib/state/shortcuts.js';
	import { formatAge, formatCount } from '$lib/formats.js';
	import { version } from '$lib/version.js';
	import type { Conversation } from '$lib/types.js';
	import type { CodingTaskStatus } from '$lib/coding-environments.js';
	import { CODING_PR_STATE_STYLE, WAITING_HINT } from '$lib/coding-status.js';
	import CodingRunTimer from './CodingRunTimer.svelte';
	import WaitingMark from './WaitingMark.svelte';
	import PullRequestIcon from './PullRequestIcon.svelte';
	import SidebarPlanLimits from './usage/SidebarPlanLimits.svelte';
	import SnoozeMenuItems from './SnoozeMenuItems.svelte';
	import SnoozeDialog from './SnoozeDialog.svelte';
	import AlarmClockIcon from '@lucide/svelte/icons/alarm-clock';
	import { formatSnoozeTime, isSnoozed } from '$lib/snooze.js';

	let {
		user,
		conversations,
		hasMore,
		unreadIds,
		snoozed = [],
		settledCount,
		autoSettleDays,
		onclose,
		onshowshortcuts,
		onopenresult,
		closeButton = $bindable(null),
		searchInput = $bindable(null)
	}: {
		user: { name: string; email: string; image: string | null; role: string };
		conversations: Conversation[];
		hasMore: boolean;
		unreadIds: string[];
		/** Snoozed chats, soonest to wake first; listed in their own group below the dated ones. */
		snoozed?: Conversation[];
		settledCount: number;
		autoSettleDays: number;
		onclose: () => void;
		/** Opens the keyboard shortcuts dialog. */
		onshowshortcuts: () => void;
		/** A search result was opened from the keyboard; focus belongs in the chat now. */
		onopenresult?: () => void;
		/** The header's close button, so the layout can move focus to it on open. */
		closeButton?: HTMLElement | null;
		/** The search box, so the layout's search shortcut can focus it after opening the sidebar. */
		searchInput?: HTMLInputElement | null;
	} = $props();

	const isMobile = new MediaQuery('(max-width: 767px)');

	function handleNavigate() {
		if (isMobile.current) onclose();
	}

	/**
	 * Rows paged in below the layout's first page, and the first page (`base`)
	 * they continue. A sidebar refresh brings a new base; the paged rows then
	 * stay (minus any the new base now holds) while the same range is fetched
	 * again, so scrolling down isn't undone by every refresh.
	 */
	let paged = $state.raw<{ base: Conversation[]; rows: Conversation[]; hasMore: boolean }>(
		(() => ({ base: conversations, rows: [], hasMore }))()
	);
	let loadingMore = $state(false);

	const extras = $derived.by(() => {
		if (paged.base === conversations) return paged.rows;
		const inBase = new Set(conversations.map((c) => c.id));
		return paged.rows.filter((c) => !inBase.has(c.id));
	});
	const hasMorePages = $derived(paged.rows.length > 0 ? paged.hasMore : hasMore);

	function observeSentinel(node: HTMLElement) {
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) void loadMore();
		});
		observer.observe(node);
		return () => observer.disconnect();
	}

	/** One page of the active list; `limit` is capped at 200 by the endpoint. */
	async function fetchConversations(
		offset: number,
		limit?: number
	): Promise<{ conversations: Conversation[]; hasMore: boolean } | null> {
		const res = await fetch(
			`/api/conversations?offset=${offset}${limit ? `&limit=${limit}` : ''}`
		).catch(() => null);
		if (!res?.ok) return null;
		return (await res.json()) as { conversations: Conversation[]; hasMore: boolean };
	}

	function appendNew(known: Conversation[], rows: Conversation[]): Conversation[] {
		const ids = new Set(known.map((c) => c.id));
		// Pages fetched while the list shifts can overlap, also with each other.
		return rows.filter((c, i) => !ids.has(c.id) && rows.findIndex((r) => r.id === c.id) === i);
	}

	async function loadMore() {
		if (loadingMore || !hasMorePages) return;
		loadingMore = true;
		try {
			const base = conversations;
			const rows = extras;
			const data = await fetchConversations(base.length + rows.length);
			if (!data) return;
			// Kept against the base it continues; if that was replaced meanwhile,
			// the effect below fetches the whole range again.
			paged = {
				base,
				rows: [...rows, ...appendNew([...base, ...rows], data.conversations)],
				hasMore: data.hasMore
			};
		} finally {
			loadingMore = false;
		}
	}

	/** Fetches the paged-in range again after the first page was refreshed. */
	async function refreshPaged(base: Conversation[], count: number) {
		loadingMore = true;
		try {
			const rows: Conversation[] = [];
			let more = true;
			while (more && rows.length < count) {
				const data = await fetchConversations(
					base.length + rows.length,
					Math.min(200, count - rows.length)
				);
				if (!data) {
					// Keep what's showing rather than retrying in a loop.
					paged = { base, rows: extras, hasMore: paged.hasMore };
					return;
				}
				rows.push(...data.conversations);
				more = data.hasMore && data.conversations.length > 0;
			}
			paged = { base, rows: appendNew(base, rows), hasMore: more };
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		if (loadingMore || paged.base === conversations || paged.rows.length === 0) return;
		const base = conversations;
		const count = paged.rows.length;
		untrack(() => void refreshPaged(base, count));
	});

	const allConversations = $derived([...conversations, ...extras]);

	const SETTLED_OPEN_KEY = 'chatty.sidebar.settledOpen';
	let settledOpen = $state(false);
	let settledItems = $state<Conversation[] | null>(null);
	let settledHasMore = $state(false);
	let settledLoading = $state(false);
	let settledError = $state(false);

	/** Spoken status for the shelf; background refreshes of a shown list stay silent. */
	const settledAnnouncement = $derived.by(() => {
		if (!settledOpen) return '';
		const empty = !settledItems?.length;
		if (settledError) {
			return empty ? "Couldn't load the settled list" : "Couldn't load more of the settled list";
		}
		return empty && settledLoading ? 'Loading settled conversations' : '';
	});

	async function loadSettled(reset: boolean) {
		if (settledLoading && !reset) return;
		settledLoading = true;
		settledError = false;
		try {
			const offset = reset ? 0 : (settledItems?.length ?? 0);
			// A refresh keeps as many rows as are showing, so "Show more" isn't undone.
			const limit = reset && settledItems?.length ? `&limit=${settledItems.length}` : '';
			const res = await fetch(`/api/conversations/settled?offset=${offset}${limit}`).catch(
				() => null
			);
			if (!res?.ok) {
				settledError = true;
				return;
			}
			const data = (await res.json()) as { conversations: Conversation[]; hasMore: boolean };
			const previous = reset ? [] : (settledItems ?? []);
			const known = new Set(previous.map((c) => c.id));
			settledItems = [...previous, ...data.conversations.filter((c) => !known.has(c.id))];
			settledHasMore = data.hasMore;
		} finally {
			settledLoading = false;
		}
	}

	// Snoozed chats come with the layout data, so their shelf only remembers whether it's open.
	const SNOOZED_OPEN_KEY = 'chatty.sidebar.snoozedOpen';
	let snoozedOpen = $state(false);

	function toggleSnoozedShelf() {
		snoozedOpen = !snoozedOpen;
		try {
			localStorage.setItem(SNOOZED_OPEN_KEY, snoozedOpen ? '1' : '0');
		} catch {
			// storage unavailable; the shelf just won't remember its state
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

	/**
	 * Drops a deleted conversation from the lists the sidebar holds itself (paged-in
	 * rows, the settled shelf, search results); the layout data is reloaded separately.
	 */
	function forgetConversation(id: string) {
		if (paged.rows.some((c) => c.id === id)) {
			paged = { ...paged, rows: paged.rows.filter((c) => c.id !== id) };
		}
		if (settledItems?.some((c) => c.id === id)) {
			settledItems = settledItems.filter((c) => c.id !== id);
		}
		if (searchResults?.some((c) => c.id === id)) {
			searchResults = searchResults.filter((c) => c.id !== id);
			if (activeResultId === id) activeResultId = null;
		}
	}

	/** Refreshes everything that depends on settled state after a change. */
	async function refreshSettled() {
		if (settledOpen) void loadSettled(true);
		else settledItems = null;
		if (searchResults) void search();
	}

	let query = $state('');
	let searchResults = $state<Conversation[] | null>(null);
	let activeResultId = $state<string | null>(null);
	let renameTarget = $state<Conversation | null>(null);
	let renameText = $state('');
	let deleteTarget = $state<Conversation | null>(null);
	/** The chat the custom snooze time dialog is open for. */
	let snoozeTarget = $state<Conversation | null>(null);
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
		if (completed) await invalidateWhenIdle(CONVERSATIONS_KEY);
	}

	onMount(() => {
		try {
			settledOpen = localStorage.getItem(SETTLED_OPEN_KEY) === '1';
		} catch {
			settledOpen = false;
		}
		if (settledOpen) void loadSettled(true);
		try {
			snoozedOpen = localStorage.getItem(SNOOZED_OPEN_KEY) === '1';
		} catch {
			snoozedOpen = false;
		}
		refreshAgentStats();
		refreshMemoryCount();
		refreshSkillCount();
		if (user.role === 'admin') refreshRequestCount();
		refreshActiveChats().catch(() => {});
		// Stream and new-chat events only change the sidebar's list, so they
		// refresh just that; conversation changes may also show on the open page.
		// An open chat reloads only for its own changes: its page load is the
		// heaviest one (a page of messages), and a running coding task elsewhere
		// changes often. Other pages may show any conversation, so they reload.
		const affectsOpenPage = (conversationIds: string[]) =>
			page.route.id !== '/(app)/chat/[id]' || conversationIds.includes(page.params.id ?? '');
		const isOpenChat = (conversationId: string) =>
			page.route.id === '/(app)/chat/[id]' && page.params.id === conversationId;
		// Batched with the open chat's own read-marker refresh (see scheduleInvalidate).
		const refresh = (reloadPage = true) =>
			void scheduleInvalidate(reloadPage ? undefined : CONVERSATIONS_KEY);
		const offEvents = onServerEvent((event) => {
			switch (event.type) {
				case 'chat.stream.started':
					serverActiveChats.set(event.conversationId, event.startedAt ?? Date.now());
					break;
				case 'chat.stream.finished':
					serverActiveChats.delete(event.conversationId);
					refresh(false);
					break;
				case 'chat.created':
					refresh(false);
					break;
				case 'conversation.updated':
				case 'coding.task.updated':
					refresh(affectsOpenPage([event.conversationId]));
					break;
				case 'conversation.settle_changed':
					refresh(affectsOpenPage(event.conversationIds));
					void refreshSettled();
					break;
				case 'conversation.snooze_changed':
					refresh(affectsOpenPage(event.conversationIds));
					if (searchResults) void search();
					break;
				case 'conversation.deleted':
					forgetConversation(event.conversationId);
					refresh(false);
					break;
				case 'agent.run.started':
				case 'agent.run.finished':
					refreshAgentStats();
					// Dispatched runs are chats: their row's state changes with the run,
					// and so does the open one's header.
					if (event.conversationId) refresh(isOpenChat(event.conversationId));
					break;
				case 'agent.run.awaiting_input':
					refresh(false);
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
		};
	});

	const currentId = $derived(page.params.id ?? '');

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
			// A snooze ending counts as activity: the chat comes back at the top.
			const at = Math.max(c.updatedAt, c.wokeAt ?? 0);
			if (c.pinned) groups[0].items.push(c);
			else if (at >= startOfDay) groups[1].items.push(c);
			else if (at >= startOfDay - day) groups[2].items.push(c);
			else if (at >= startOfDay - 7 * day) groups[3].items.push(c);
			else groups[4].items.push(c);
		}
		return groups.filter((g) => g.items.length > 0);
	}

	// A page loaded after the layout data may already hold a chat that woke since.
	const shownSnoozed = $derived.by(() => {
		const active = new Set(allConversations.map((c) => c.id));
		return snoozed.filter((c) => !active.has(c.id));
	});
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

	// The list renders from keys alone, and keeps the same array while they're
	// unchanged: a refresh that only updates rows' contents then doesn't rerun
	// the keyed each, whose `animate:flip` measures every row on each run.
	// Rows read their conversation from `entryRows` instead.
	type ListSlot = Exclude<ListEntry, { kind: 'row' }> | { kind: 'row'; key: string };
	let lastSlots: ListSlot[] = [];
	const listSlots = $derived.by(() => {
		// A header's key holds its label, so equal keys mean an equal list.
		const next = visibleEntries.map((e): ListSlot =>
			e.kind === 'row' ? { kind: 'row', key: e.key } : e
		);
		const same =
			next.length === lastSlots.length && next.every((s, i) => s.key === lastSlots[i].key);
		if (!same) lastSlots = next;
		return lastSlots;
	});
	const entryRows = $derived(
		new Map(visibleEntries.flatMap((e) => (e.kind === 'row' ? [[e.key, e.conversation]] : [])))
	);

	const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
	const flipDuration = $derived(reducedMotion.current ? 0 : 200);
	const fadeDuration = $derived(reducedMotion.current ? 0 : 150);

	// One request per keystroke; only the latest may set the results, so a slow
	// earlier response can't replace them (and Enter can't open a stale match).
	let searchSeq = 0;
	/** The query the shown results answer; while a newer one is loading, keys wait. */
	let resultsQuery = '';
	async function search() {
		const seq = ++searchSeq;
		const q = query.trim();
		if (!q) {
			searchResults = null;
			activeResultId = null;
			return;
		}
		const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(q)}`);
		if (!res.ok) return;
		const data = (await res.json()) as { conversations: Conversation[] };
		if (seq !== searchSeq) return;
		searchResults = data.conversations;
		resultsQuery = q;
		activeResultId = null;
	}

	function clearSearch() {
		searchSeq++;
		query = '';
		searchResults = null;
		activeResultId = null;
	}

	// ↑/↓ move through the search results and Enter opens the highlighted one
	// (or the first), while focus stays in the search box (`activeResultId`, above).
	// The highlight is only a ring, so screen readers hear which result it moved to.
	// Results in the order they're shown (grouped by date, pinned first).
	const shownResults = $derived(
		searchResults ? visibleEntries.flatMap((e) => (e.kind === 'row' ? [e.conversation] : [])) : []
	);
	const activeResultAnnouncement = $derived.by(() => {
		const index = shownResults.findIndex((c) => c.id === activeResultId);
		const c = shownResults[index];
		return c ? `${displayTitle(c)}, ${index + 1} of ${shownResults.length}` : '';
	});
	let listEl = $state<HTMLElement | null>(null);

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.isComposing) return;
		// Esc clears the search here; it never reaches the chat (which would stop a reply).
		if (event.key === 'Escape' && !event.shiftKey && query) {
			event.preventDefault();
			clearSearch();
			return;
		}
		if (!searchResults || resultsQuery !== query.trim()) return;
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const ids = shownResults.map((c) => c.id);
		if (ids.length === 0) return;
		const index = activeResultId ? ids.indexOf(activeResultId) : -1;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			const next = index === -1 ? (step === 1 ? 0 : ids.length - 1) : index + step;
			activeResultId = ids[(next + ids.length) % ids.length];
			listEl
				?.querySelector(`a[data-conversation-id="${CSS.escape(activeResultId)}"]`)
				?.scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'Enter') {
			event.preventDefault();
			void goto(resolve(`/chat/${activeResultId ?? ids[0]}`)).then(() => onopenresult?.());
			handleNavigate();
		}
	}

	async function newChat() {
		clearSearch();
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
		return c.modelId?.split('/').pop() ?? '';
	}

	function settledTitle(c: Conversation): string {
		const title = displayTitle(c);
		if (c.settledAt === null) return title;
		const age = formatAge(Date.now() - c.settledAt);
		const ago = age === '<1m' ? 'just now' : `${age} ago`;
		if (c.settledReason !== 'auto') return `${title}\nSettled ${ago}`;
		const after = autoSettleDays > 0 ? ` after ${autoSettleDays} days` : '';
		return `${title}\nAuto-settled${after} of inactivity · ${ago}`;
	}

	type RowStatus = { label: string; tone: string };

	/** What a seen (idle) coding task last ended in; a plain finished task says nothing. */
	const IDLE_CODING_STATUS: Partial<Record<CodingTaskStatus, RowStatus>> = {
		failed: { label: 'Failed', tone: 'text-destructive' },
		interrupted: { label: 'Stopped', tone: 'text-muted-foreground' }
	};

	/**
	 * One inbox-style state for every row, chat or coding task. Anything but
	 * `working`, `waiting` and `idle` asks the user to look at the conversation.
	 */
	type RowState = 'working' | 'waiting' | 'needs-you' | 'failed' | 'unread' | 'idle';

	/** The status words on a row's second line, in the same tone as its mark. */
	function rowStatus(c: Conversation, state: RowState): RowStatus | null {
		switch (state) {
			case 'working':
				return { label: 'Working', tone: 'text-info-foreground' };
			case 'waiting':
				return { label: 'Waiting', tone: 'text-muted-foreground' };
			case 'needs-you':
				return { label: 'Needs you', tone: 'text-warning-foreground' };
			case 'failed':
				return { label: 'Failed', tone: 'text-destructive' };
			case 'unread':
				return { label: c.coding ? 'Done' : 'New reply', tone: 'text-success-foreground' };
			case 'idle':
				return c.coding ? (IDLE_CODING_STATUS[c.coding.status] ?? null) : null;
		}
	}

	function rowState(c: Conversation): RowState {
		const status = c.coding?.status;
		// A question or approval blocks the agent mid-run, so its reply stream is
		// still open: the wait for you outranks "working". An agent run that asked
		// a question waits the same way.
		if (status === 'awaiting_input' || c.agentRun?.status === 'awaiting_input') return 'needs-you';
		if (
			activeChats.has(c.id) ||
			serverActiveChats.has(c.id) ||
			status === 'running' ||
			status === 'starting'
		)
			return 'working';
		// The run ended, but the agent picks up again once its background work
		// (a delegated task, a watched pull request) reports back: not done yet.
		if (status === 'waiting') return 'waiting';
		// Failures, like replies, stop asking for attention once they've been seen.
		const unread = unreadIds.includes(c.id) && page.url.pathname !== `/chat/${c.id}`;
		if (!unread) return 'idle';
		return status === 'failed' ? 'failed' : 'unread';
	}

	function rowTitle(c: Conversation, state: RowState): string {
		const title =
			c.settledAt !== null
				? settledTitle(c)
				: isSnoozed(c)
					? `${displayTitle(c)}\nSnoozed until ${formatSnoozeTime(c.snoozedUntil!)}`
					: displayTitle(c);
		const details = [
			c.coding ? 'Coding task' : null,
			c.coding ? c.coding.projectTitle : chatSource(c),
			state === 'waiting' ? WAITING_HINT : rowStatus(c, state)?.label
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
			forgetConversation(id);
			toast.success('Conversation deleted');
			if (currentId === id) await goto(resolve('/'));
			await invalidateAll();
		} else {
			toast.error('Failed to delete conversation');
		}
	}

	// Phones: a tile's count sits inline after its label ("Skills 9"), muted.
	const tileBadge = 'max-md:ml-0 max-md:gap-1 max-md:text-[11px]';

	// A Workspace link: a row on desktop, a 4-up tile on phones.
	const isCurrent = (path: string) => page.url.pathname.startsWith(path);
	function tileClass(path: string) {
		return `mb-0.5 flex items-center gap-2 rounded-md px-2 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-md:mb-0 max-md:flex-col max-md:gap-1 max-md:text-xs pointer-coarse:py-2.5 ${
			isCurrent(path)
				? 'bg-accent text-accent-foreground'
				: 'text-muted-foreground hover:bg-accent/50'
		}`;
	}
</script>

{#snippet row(c: Conversation)}
	{@const snoozedUntil = isSnoozed(c) ? c.snoozedUntil : null}
	<!-- Snoozed rows are put away for now, like settled ones: quiet until they wake. -->
	{@const settled = c.settledAt !== null || snoozedUntil !== null}
	{@const state = rowState(c)}
	{@const attention =
		!settled && (state === 'needs-you' || state === 'failed' || state === 'unread')}
	{@const status = rowStatus(c, state)}
	{@const leads = state === 'working' || state === 'waiting' || attention}
	{@const source = c.coding ? c.coding.projectTitle : chatSource(c)}
	<!-- The type icon takes the title's emphasis: full strength on rows that need you. -->
	{@const iconTone =
		attention || c.id === currentId
			? ''
			: settled
				? 'text-muted-foreground'
				: 'text-muted-foreground group-focus-within:text-foreground group-hover:text-foreground'}
	{@const runStartedAt =
		state !== 'working'
			? null
			: c.coding
				? c.coding.runStartedAt
				: (serverActiveChats.get(c.id) ?? null)}
	<div
		class="group mb-0.5 flex w-full items-start rounded-md text-sm {c.id === currentId
			? 'bg-accent text-accent-foreground'
			: 'hover:bg-accent/50'} {settled && c.id !== currentId
			? 'text-muted-foreground'
			: ''} {searchResults && c.id === activeResultId ? 'ring-2 ring-ring/50' : ''}"
	>
		<a
			href={resolve(`/chat/${c.id}`)}
			data-conversation-id={c.id}
			class="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
			title={rowTitle(c, state)}
			onclick={handleNavigate}
		>
			{#if c.coding}
				<CodeIcon class="mt-[3px] size-3.5 shrink-0 {iconTone}" aria-hidden="true" />
				<span class="sr-only">Coding task:</span>
			{:else if c.origin === 'dispatch'}
				<!-- Started by an agent run rather than by you. -->
				<BotIcon class="mt-[3px] size-3.5 shrink-0 {iconTone}" aria-hidden="true" />
				<span class="sr-only">Agent chat:</span>
			{:else}
				<MessageCircleIcon class="mt-[3px] size-3.5 shrink-0 {iconTone}" aria-hidden="true" />
				<span class="sr-only">Chat:</span>
			{/if}
			<!-- Chats and coding tasks share one layout: the title, then where it runs
			     (project or model) and the PR. While something is happening or new, its
			     status leads the second line with a mark; settled facts trail it quietly. -->
			<span class="flex min-w-0 flex-1 flex-col">
				<span
					class="min-w-0 truncate leading-5 {attention
						? 'font-semibold'
						: state === 'idle' && !settled && c.id !== currentId
							? 'text-foreground/70 group-focus-within:text-foreground group-hover:text-foreground dark:text-foreground/60'
							: ''}">{displayTitle(c)}</span
				>
				<!-- Nothing to say (a chat with no model on record and no status): one line. -->
				{#if source || status || snoozedUntil || c.coding?.pullRequest}
					<span class="flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
						<span class="sr-only">,</span>
						{#if status && leads}
							<span class="inline-flex shrink-0 items-center gap-1 {status.tone}">
								<span class="flex size-3 items-center justify-center" aria-hidden="true">
									{#if state === 'working'}
										<!-- Synced so every working row's spinner turns together. -->
										<span class="flex animate-spin motion-reduce:hidden" {@attach syncAnimation}>
											<LoaderCircleIcon class="size-3" strokeWidth={2.5} />
										</span>
										<!-- A frozen spinner looks broken; reduced motion gets a still mark. -->
										<CircleDotDashedIcon
											class="hidden size-3 motion-reduce:block"
											strokeWidth={2.5}
										/>
									{:else if state === 'waiting'}
										<WaitingMark />
									{:else if state === 'needs-you'}
										<CircleAlertIcon class="size-3" strokeWidth={2.5} />
									{:else if state === 'failed'}
										<TriangleAlertIcon class="size-3" strokeWidth={2.5} />
									{:else}
										<span class="size-2 rounded-full bg-success"></span>
									{/if}
								</span>
								{status.label}
								{#if runStartedAt}
									<span aria-hidden="true">
										<CodingRunTimer startedAt={runStartedAt} dot={false} />
									</span>
								{/if}
							</span>
							{#if source}<span class="shrink-0" aria-hidden="true">·</span>{/if}
						{/if}
						{#if snoozedUntil}
							<!-- When it comes back leads: that's what a snoozed row is about. -->
							<span class="inline-flex shrink-0 items-center gap-1">
								<AlarmClockIcon class="size-3" strokeWidth={2.5} aria-hidden="true" />
								<span class="sr-only">Snoozed until</span>
								{formatSnoozeTime(snoozedUntil)}
							</span>
							{#if source}<span class="shrink-0" aria-hidden="true">·</span>{/if}
						{/if}
						{#if source}<span class="truncate">{source}</span>{/if}
						{#if status && !leads}
							{#if source}<span class="shrink-0" aria-hidden="true">·</span>{/if}
							<!-- Settled rows are put away: their words stay, without the colour. -->
							<span class="shrink-0 {settled ? '' : status.tone}">{status.label}</span>
						{/if}
						{#if c.coding?.pullRequest}
							{@const prState = c.coding.pullRequest.state}
							{@const prLabel = prState
								? `Pull request ${CODING_PR_STATE_STYLE[prState].label.toLowerCase()}`
								: 'Has a pull request'}
							<span class="ml-auto inline-flex shrink-0 items-center pl-2" title={prLabel}>
								<!-- Muted so it never reads as a second status mark; its shape still tells the state. -->
								<PullRequestIcon state={prState} class="size-3 text-muted-foreground!" />
								<span class="sr-only">, {prLabel}</span>
							</span>
						{/if}
					</span>
				{/if}
			</span>
		</a>
		{#if searchResults && settled}
			<span
				class="mt-2 mr-1 shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground group-hover:hidden"
				>{snoozedUntil !== null ? 'Snoozed' : 'Settled'}</span
			>
		{/if}
		{@render rowActions(c, state, 'mt-1.5 pointer-coarse:mt-0.5')}
	</div>
{/snippet}

<!-- Settled rows are put away: one quiet line each, with how long ago they were settled. -->
{#snippet settledRow(c: Conversation)}
	{@const state = rowState(c)}
	{@const status = state === 'idle' ? null : rowStatus(c, state)}
	{@const current = c.id === currentId}
	<div
		class="group mb-0.5 flex w-full items-center rounded-md text-sm {current
			? 'bg-accent text-accent-foreground'
			: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground/85'}"
	>
		<a
			href={resolve(`/chat/${c.id}`)}
			data-conversation-id={c.id}
			class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:py-2.5"
			title={rowTitle(c, state)}
			onclick={handleNavigate}
		>
			{#if c.coding}
				<CodeIcon class="size-3.5 shrink-0" aria-hidden="true" />
				<span class="sr-only">Coding task:</span>
			{:else if c.origin === 'dispatch'}
				<BotIcon class="size-3.5 shrink-0" aria-hidden="true" />
				<span class="sr-only">Agent chat:</span>
			{:else}
				<MessageCircleIcon class="size-3.5 shrink-0" aria-hidden="true" />
				<span class="sr-only">Chat:</span>
			{/if}
			<span class="min-w-0 flex-1 truncate leading-5">{displayTitle(c)}</span>
			<!-- Put away, but still worth a look: a small mark in the status's tone. -->
			{#if status}
				<span class="flex size-3 shrink-0 items-center justify-center {status.tone}">
					<span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
					<span class="sr-only">, {status.label}</span>
				</span>
			{/if}
			{#if c.settledAt !== null}
				{@const age = formatAge(Date.now() - c.settledAt)}
				<span
					class="shrink-0 text-xs text-muted-foreground tabular-nums group-focus-within:hidden group-hover:hidden pointer-coarse:hidden {menuOpenId ===
					c.id
						? 'hidden'
						: ''}"
				>
					{#if age === '<1m'}
						<span class="sr-only">, settled just</span> now
					{:else}
						<span class="sr-only">, settled</span>
						{age}
						<span class="sr-only">ago</span>
					{/if}
				</span>
			{/if}
		</a>
		{@render rowActions(c, state, '')}
	</div>
{/snippet}

<!-- A shelf below the dated groups: a hairline, then a header that reads like theirs. -->
{#snippet shelfHeader(
	label: string,
	count: number,
	open: boolean,
	controls: string,
	ontoggle: () => void
)}
	<div class="mx-2 mt-3 border-t" aria-hidden="true"></div>
	<button
		type="button"
		class="group/shelf mt-2 mb-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:py-2"
		aria-expanded={open}
		aria-controls={controls}
		onclick={ontoggle}
	>
		{label}
		<span class="font-normal tabular-nums">{count}</span>
		<span class="sr-only">conversations</span>
		<ChevronRightIcon
			class="ml-auto size-3.5 opacity-60 transition-transform group-hover/shelf:opacity-100 motion-reduce:transition-none {open
				? 'rotate-90'
				: ''}"
			aria-hidden="true"
		/>
	</button>
{/snippet}

{#snippet rowActions(c: Conversation, state: RowState, offset: string)}
	{@const settled = c.settledAt !== null}
	<span
		class="{offset} shrink-0 gap-0.5 pr-1 group-focus-within:flex group-hover:flex pointer-coarse:flex {menuOpenId ===
		c.id
			? 'flex'
			: 'hidden'}"
	>
		<button
			class="rounded p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:hidden"
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
						class="rounded p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:p-2"
						title="More actions"
						aria-label="More actions"
					>
						<EllipsisIcon class="size-4" />
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="w-44">
				<!-- Touch has no hover, so the row's Settle button is hidden there; offer it here. -->
				<DropdownMenu.Item
					class="pointer-fine:hidden"
					onSelect={() => void setSettled(c, !settled)}
				>
					{#if settled}<ArchiveRestoreIcon class="size-4" /> Un-settle{:else}<ArchiveIcon
							class="size-4"
						/> Settle{/if}
				</DropdownMenu.Item>
				{#if !settled}
					<DropdownMenu.Item onSelect={() => void togglePin(c.id)}>
						{#if c.pinned}<PinOffIcon class="size-4" /> Unpin{:else}<PinIcon class="size-4" /> Pin{/if}
					</DropdownMenu.Item>
				{/if}
				<SnoozeMenuItems
					conversation={c}
					onchanged={() => invalidateAll()}
					oncustom={() => (snoozeTarget = c)}
				/>
				{#if state !== 'working' && state !== 'waiting' && state !== 'needs-you' && c.id !== currentId}
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
{/snippet}

<!-- Phones: clip, so nothing pokes out of the closed drawer onto the page. The drawer also
     gets an opaque (pre-mixed) tint there: iOS colours the translucent status bar from a
     solid background at the top and falls back to a soft fade over a see-through one,
     which washed out the header. -->
<aside
	class="flex h-full w-72 shrink-0 flex-col border-r bg-muted/30 max-md:overflow-hidden max-md:bg-[color-mix(in_oklab,var(--muted)_30%,var(--background))]"
>
	<div
		class="flex items-center justify-between gap-2 p-3 pt-[calc(0.75rem+env(safe-area-inset-top))] max-md:pt-[calc(0.25rem+env(safe-area-inset-top))]"
	>
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
		<!-- Desktop: the same panel icon as the floating "open sidebar" button, so the pair reads
		     as one toggle. Phones: the full-screen drawer closes with an X. -->
		<Button
			variant="ghost"
			size="icon-sm"
			bind:ref={closeButton}
			onclick={() => onclose()}
			aria-label="Close sidebar"
			title="Close sidebar ({shortcutLabel('toggle-sidebar')})"
		>
			<XIcon class="size-[18px] md:hidden" strokeWidth={1.75} />
			<PanelLeftIcon class="size-4 max-md:hidden" strokeWidth={1.75} />
		</Button>
	</div>

	<div class="px-3 pb-2">
		<div class="relative">
			<Input
				bind:ref={searchInput}
				placeholder="Search conversations…"
				title="Search conversations ({shortcutLabel('search')})"
				bind:value={query}
				oninput={search}
				onkeydown={onSearchKeydown}
				onblur={() => (activeResultId = null)}
				aria-describedby="search-hint"
				class="h-8 pr-8 text-sm pointer-coarse:h-10 pointer-coarse:pr-11"
			/>
			<span id="search-hint" class="sr-only"
				>Up and down arrows move through the results; Enter opens one.</span
			>
			<span class="sr-only" aria-live="polite">{activeResultAnnouncement}</span>
			<button
				type="button"
				class="absolute top-1/2 right-1 -translate-y-1/2 rounded-full bg-primary p-1 text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:p-2"
				onclick={() => {
					newChat();
					handleNavigate();
				}}
				title="New chat ({shortcutLabel('new-chat')})"
				aria-label="New chat"
			>
				<PlusIcon class="size-4" />
			</button>
		</div>
	</div>
	<nav
		bind:this={listEl}
		class="flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)] px-2 pb-2"
	>
		{#each listSlots as entry (entry.key)}
			{@const conversation = entry.kind === 'row' ? entryRows.get(entry.key) : undefined}
			<div
				animate:flip={{ duration: flipDuration, easing: cubicOut }}
				transition:fade={{ duration: fadeDuration }}
			>
				{#if entry.kind === 'header'}
					<p class="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">{entry.label}</p>
				{:else if conversation}
					{@render row(conversation)}
				{/if}
			</div>
		{:else}
			<p class="px-2 pt-4 text-sm text-muted-foreground">
				{searchResults
					? 'No matches.'
					: settledCount > 0 || shownSnoozed.length > 0
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
		{#if !searchResults && shownSnoozed.length > 0}
			{@render shelfHeader(
				'Snoozed',
				shownSnoozed.length,
				snoozedOpen,
				'snoozed-shelf',
				toggleSnoozedShelf
			)}
			<div id="snoozed-shelf">
				{#if snoozedOpen}
					{#each shownSnoozed as c (c.id)}
						<div
							animate:flip={{ duration: flipDuration, easing: cubicOut }}
							transition:fade={{ duration: fadeDuration }}
						>
							{@render row(c)}
						</div>
					{/each}
				{/if}
			</div>
		{/if}
		{#if !searchResults && (settledCount > 0 || (settledItems?.length ?? 0) > 0)}
			{@render shelfHeader(
				'Settled',
				settledCount,
				settledOpen,
				'settled-shelf',
				toggleSettledShelf
			)}
			<!-- Announces what the spinner and error line show. -->
			<p class="sr-only" aria-live="polite">
				{settledAnnouncement}
			</p>
			<div id="settled-shelf">
				{#if settledOpen}
					{#each settledItems ?? [] as c (c.id)}
						<div
							animate:flip={{ duration: flipDuration, easing: cubicOut }}
							transition:fade={{ duration: fadeDuration }}
						>
							{@render settledRow(c)}
						</div>
					{:else}
						{#if settledLoading}
							<div class="flex justify-center py-2">
								<LoaderCircleIcon class="size-4 animate-spin text-muted-foreground" />
							</div>
						{:else if settledItems && !settledError}
							<p class="px-2 py-1 text-xs text-muted-foreground">Nothing settled.</p>
						{/if}
					{/each}
					{#if settledError}
						<p class="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
							<CircleAlertIcon class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
							<span class="truncate">Couldn't load the settled list.</span>
							<button
								type="button"
								class="shrink-0 rounded font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:px-1 pointer-coarse:py-2"
								onclick={() => loadSettled(settledItems === null || settledItems.length === 0)}
							>
								Retry
							</button>
						</p>
					{:else if settledHasMore}
						{@const remaining = settledCount - (settledItems?.length ?? 0)}
						<!-- Lines up with the row titles above it. -->
						<button
							type="button"
							class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:py-2.5"
							disabled={settledLoading}
							onclick={() => loadSettled(false)}
						>
							<span class="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
								{#if settledLoading}
									<LoaderCircleIcon class="size-3.5 animate-spin" />
								{:else}
									<EllipsisIcon class="size-3.5 opacity-60" />
								{/if}
							</span>
							{remaining > 0 ? `Show ${remaining} more` : 'Show more'}
						</button>
					{/if}
				{/if}
			</div>
		{/if}
	</nav>

	<!-- Phones: a compact 4-up row, so the drawer's room goes to conversations. -->
	<div
		class="px-2 pt-2 pb-2 max-md:grid max-md:grid-cols-[repeat(4,minmax(0,1fr))_auto] max-md:gap-1 max-md:border-t max-md:px-3 max-md:pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
	>
		<p class="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground max-md:hidden">Workspace</p>
		<a
			href={resolve('/agents')}
			class={tileClass('/agents')}
			aria-current={isCurrent('/agents') ? 'page' : undefined}
			onclick={handleNavigate}
		>
			<BotIcon class="size-4" />
			<!-- Desktop: `contents` lets the count keep its right-aligned slot in the row. -->
			<span class="flex items-baseline gap-1 md:contents">
				Agents
				{#if agentStats && agentStats.running > 0}
					{@const runningLabel = `${agentStats.running} ${agentStats.running === 1 ? 'agent' : 'agents'} running`}
					<!-- Only activity earns a badge: a bare total of built-ins read as "you have agents"
						next to an empty Agents page. -->
					<span
						class="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums {tileBadge}"
						title={runningLabel}
					>
						<span class="sr-only">{runningLabel}</span>
						<span
							class="size-1.5 animate-pulse rounded-full bg-info motion-reduce:animate-none"
							aria-hidden="true"
						></span>
						<span aria-hidden="true"
							>{agentStats.running}<span class="ml-1 max-md:hidden">running</span></span
						>
					</span>
				{/if}
			</span>
		</a>
		<a
			href={resolve('/memory')}
			class={tileClass('/memory')}
			aria-current={isCurrent('/memory') ? 'page' : undefined}
			onclick={handleNavigate}
		>
			<BrainIcon class="size-4" />
			<!-- Desktop: `contents` lets the count keep its right-aligned slot in the row. -->
			<span class="flex items-baseline gap-1 md:contents">
				Memory
				<!-- A zero is noise; the Memory page says it's empty. -->
				{#if memoryCount}
					<span
						class="ml-auto text-xs text-muted-foreground tabular-nums {tileBadge}"
						title="{memoryCount} {memoryCount === 1 ? 'memory' : 'memories'}"
						>{memoryCount}<span class="sr-only">
							{memoryCount === 1 ? 'memory' : 'memories'}</span
						></span
					>
				{/if}
			</span>
		</a>
		<a
			href={resolve('/skills')}
			class={tileClass('/skills')}
			aria-current={isCurrent('/skills') ? 'page' : undefined}
			onclick={handleNavigate}
		>
			<SparklesIcon class="size-4" />
			<!-- Desktop: `contents` lets the count keep its right-aligned slot in the row. -->
			<span class="flex items-baseline gap-1 md:contents">
				Skills
				{#if skillCount !== null}
					<span
						class="ml-auto text-xs text-muted-foreground tabular-nums {tileBadge} {skillCount === 0
							? 'max-md:hidden'
							: ''}"
						title="{skillCount} {skillCount === 1 ? 'skill' : 'skills'}"
						>{skillCount}<span class="sr-only"> {skillCount === 1 ? 'skill' : 'skills'}</span></span
					>
				{/if}
			</span>
		</a>
		<a
			href={resolve('/usage')}
			class={tileClass('/usage')}
			aria-current={isCurrent('/usage') ? 'page' : undefined}
			onclick={handleNavigate}
		>
			<GaugeIcon class="size-4" />
			<!-- Desktop: `contents` lets the count keep its right-aligned slot in the row. -->
			<span class="flex items-baseline gap-1 md:contents">
				Usage
				<span class="ml-auto inline-flex items-center gap-3 {tileBadge} max-md:gap-1">
					<!-- The subscription limit closest to its cap. -->
					<SidebarPlanLimits />
					{#if user.role === 'admin' && requestStats}
						<!-- Phones only have room for the live dot. -->
						<span
							class="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums {requestStats.running >
							0
								? ''
								: 'max-md:hidden'}"
							title="{requestStats.total} requests all time · {requestStats.running} running"
						>
							{#if requestStats.running > 0}
								<span class="size-1.5 animate-pulse rounded-full bg-info"></span>
							{/if}
							<span class="max-md:hidden pointer-coarse:hidden"
								>{formatCount(requestStats.total)}</span
							>
						</span>
					{/if}
				</span>
			</span>
		</a>
		<!-- Phones: the account row folds into this tile; Sign out lives in Settings → Account. -->
		<a
			href={resolve('/settings/account')}
			class="{tileClass('/settings')} justify-center md:hidden"
			aria-label="Settings and account ({user.name})"
			title="Settings"
			aria-current={isCurrent('/settings') ? 'page' : undefined}
			onclick={handleNavigate}
		>
			<!-- The gear says where it leads; the avatar alone reads as a profile badge. -->
			<span class="relative">
				<UserAvatar
					name={user.name}
					image={user.image}
					class="size-7 text-foreground ring-1 ring-border {isCurrent('/settings')
						? 'bg-background'
						: 'bg-muted'}"
				/>
				<SettingsIcon
					class="absolute -right-1.5 -bottom-1 size-[18px] rounded-full bg-background p-[3px] text-foreground/80 ring-1 ring-border"
					aria-hidden="true"
				/>
			</span>
		</a>
	</div>

	<div
		class="flex items-center justify-between gap-2 border-t p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-md:hidden"
	>
		<div class="flex min-w-0 items-center gap-2">
			<UserAvatar name={user.name} image={user.image} />
			<span class="min-w-0 truncate text-sm" title={user.email}>{user.name}</span>
		</div>
		<div class="flex shrink-0 gap-1">
			<Button
				variant="ghost"
				size="icon"
				href={resolve('/settings')}
				aria-label="Settings"
				aria-current={isCurrent('/settings') ? 'page' : undefined}
				title="Settings ({shortcutLabel('open-settings')})"
				class="pointer-coarse:size-11 {isCurrent('/settings') ? 'bg-accent text-foreground' : ''}"
				onclick={handleNavigate}
			>
				<SettingsIcon class="size-4" />
			</Button>
			<!-- Touch screens have no keyboard to use them with. -->
			<Button
				variant="ghost"
				size="icon"
				class="pointer-coarse:hidden"
				onclick={onshowshortcuts}
				aria-label="Keyboard shortcuts"
				title="Keyboard shortcuts ({shortcutLabel('show-shortcuts')})"
			>
				<KeyboardIcon class="size-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				class="pointer-coarse:size-11"
				onclick={signOutToLogin}
				aria-label="Sign out"
				title="Sign out"
			>
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

<SnoozeDialog
	conversation={snoozeTarget}
	onclose={() => (snoozeTarget = null)}
	onchanged={() => invalidateAll()}
/>

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
