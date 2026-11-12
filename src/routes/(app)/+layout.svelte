<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { FavoriteModels, setFavoriteModels } from '$lib/state/favorite-models.svelte.js';
	import { MediaQuery } from 'svelte/reactivity';
	import Sidebar from '$lib/components/app/Sidebar.svelte';
	import AttentionNotifier from '$lib/components/app/AttentionNotifier.svelte';
	import OfflineBanner from '$lib/components/app/OfflineBanner.svelte';
	import ShortcutsDialog from '$lib/components/app/ShortcutsDialog.svelte';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import { Button } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/utils.js';
	import { startServerEvents } from '$lib/state/events.svelte.js';
	import { startMessageQueueRunner } from '$lib/state/message-queue-runner.js';
	import { setSidebarState } from '$lib/components/app/sidebar-state.svelte.js';
	import { drawerSwipe, SETTLE_EASING } from '$lib/components/app/drawer-swipe.js';
	import { haptic, preloadHaptics } from '$lib/haptics.svelte.js';
	import {
		chatShortcuts,
		isTypingTarget,
		matchShortcut,
		modelPicker,
		shortcutLabel
	} from '$lib/state/shortcuts.js';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	const isDesktop = new MediaQuery('(min-width: 768px)');

	setFavoriteModels(new FavoriteModels(untrack(() => data.settings.favoriteModels)));

	let sidebarOpen = $state(data.sidebarOpen);
	let mobileOpen = $state(false);

	setSidebarState({
		get open() {
			return sidebarOpen;
		},
		get mobileOpen() {
			return mobileOpen;
		}
	});

	function setSidebarOpen(open: boolean) {
		sidebarOpen = open;
		void fetch('/api/user/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sidebarOpen: open })
		});
	}

	// The open and close buttons swap places, so focus follows: opening moves it to the
	// sidebar's close button, closing with that button moves it back to the floating one.
	// (Closing because a link was followed leaves focus where navigation puts it.)
	let sidebarCloseButton = $state<HTMLElement | null>(null);

	/** `moveFocus` is off for the keyboard shortcut, which leaves focus where you were typing. */
	async function toggleSidebar(moveFocus = true) {
		// Closing with focus inside (e.g. Ctrl+K, then Ctrl+B) mustn't leave it in a hidden field.
		const focusInside = !!document.activeElement?.closest('aside');
		if (isDesktop.current) {
			setSidebarOpen(!sidebarOpen);
		} else {
			mobileOpen = !mobileOpen;
		}
		await tick();
		const open = isDesktop.current ? sidebarOpen : mobileOpen;
		// The phone drawer covers the page, so focus goes into it even from the shortcut.
		if (open && (moveFocus || !isDesktop.current))
			sidebarCloseButton?.focus({ preventScroll: true });
		if (!open && focusInside && !focusComposer()) sidebarButton?.focus({ preventScroll: true });
	}

	/** Ctrl/Cmd+K: search lives in the sidebar, so show it first if it's closed. */
	let sidebarSearch = $state<HTMLInputElement | null>(null);
	async function focusSearch() {
		if (isDesktop.current) {
			if (!sidebarOpen) setSidebarOpen(true);
		} else {
			mobileOpen = true;
		}
		await tick();
		sidebarSearch?.focus({ preventScroll: true });
		sidebarSearch?.select();
	}

	async function closeSidebar() {
		const fromCloseButton = !!sidebarCloseButton && document.activeElement === sidebarCloseButton;
		if (isDesktop.current) setSidebarOpen(false);
		else mobileOpen = false;
		if (!fromCloseButton) return;
		await tick();
		sidebarButton?.focus({ preventScroll: true });
	}

	// The floating sidebar button is a plain ghost button until a page scrolls beneath
	// it; then it gets a backing so it doesn't read as part of the content (overContent).
	// Phones also hide it while scrolling down and bring it back on scroll up. Scrollers
	// that start below it (the chat timeline, under its topbar) never pass under it, so
	// they leave it alone.
	let buttonHidden = $state(false);
	let overContent = $state(false);
	let sidebarButton = $state<HTMLElement | null>(null);
	const lastScrollTop = new WeakMap<Element, number>();
	function onAnyScroll(event: Event) {
		const el = event.target;
		if (!(el instanceof Element)) return;
		const top = el.scrollTop;
		const last = lastScrollTop.get(el) ?? 0;
		lastScrollTop.set(el, top);
		// offsetTop ignores the slide-away transform, so this is where the button rests.
		const buttonBottom = sidebarButton ? sidebarButton.offsetTop + sidebarButton.offsetHeight : 48;
		if (el.getBoundingClientRect().top >= buttonBottom - 4) return;
		overContent = top > 4;
		if (isDesktop.current) return;
		if (top < 48 || top < last - 8) buttonHidden = false;
		else if (top > last + 8) buttonHidden = true;
	}
	afterNavigate(() => {
		buttonHidden = false;
		overContent = false;
	});

	// ── keyboard shortcuts (Ctrl/Cmd+K lives in the sidebar's search) ────────
	const OVERLAY = '[role=dialog], [role=alertdialog], [role=menu], [role=listbox], dialog';

	/** Focus is in, or a modal is showing, something that owns its own keys. */
	function inOverlay(target: EventTarget | null): boolean {
		if (target instanceof Element && target.closest(OVERLAY)) return true;
		return document.querySelector('[role=dialog][data-state=open], [role=alertdialog]') !== null;
	}

	function focusComposer(): boolean {
		const textarea = document.querySelector<HTMLTextAreaElement>('main textarea[data-composer]');
		if (!textarea || textarea.disabled) return false;
		textarea.focus();
		const end = textarea.value.length;
		textarea.setSelectionRange(end, end);
		return true;
	}

	/**
	 * Scrolls a sidebar row into view within its list only. `scrollIntoView` would also
	 * scroll sideways, sliding the closed phone drawer onto the screen.
	 */
	function scrollIntoList(row: HTMLElement) {
		const list = row.closest('nav');
		if (!list) return;
		const rowBox = row.getBoundingClientRect();
		const listBox = list.getBoundingClientRect();
		if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top;
		else if (rowBox.bottom > listBox.bottom) list.scrollTop += rowBox.bottom - listBox.bottom;
	}

	/** Moves to the conversation above or below the open one, in sidebar order. */
	function stepConversation(step: 1 | -1): boolean {
		const links = [...document.querySelectorAll<HTMLAnchorElement>('a[data-conversation-id]')];
		if (links.length === 0) return false;
		const current = links.findIndex((a) => a.dataset.conversationId === page.params.id);
		// From a page that isn't a listed chat, both directions start at the top (the newest).
		const next = current === -1 ? 0 : current + step;
		const target = links[next];
		const id = target?.dataset.conversationId;
		if (!id) return false;
		scrollIntoList(target);
		void goto(resolve(`/chat/${id}`));
		return true;
	}

	let shortcutsOpen = $state(false);

	// ── phone drawer swipe: right on a chat to open, left on the drawer to close ──
	let drawerTrack = $state<HTMLElement | null>(null);
	/** How far open the drawer is while a finger drags it (0..1), else null. */
	let dragProgress = $state<number | null>(null);
	/** Duration of the settle animation after a swipe, so it keeps the finger's speed. */
	let settleMs = $state<number | null>(null);
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	function isChatPage() {
		const path = page.url.pathname;
		return path === '/' || path.startsWith('/chat/');
	}

	function startDrawerSwipe(track: HTMLElement) {
		return drawerSwipe(track, {
			isOpen: () => mobileOpen,
			width: () => window.innerWidth,
			canStart(target, open) {
				if (isDesktop.current || inOverlay(target)) return false;
				if (target.closest('[data-no-swipe]')) return false;
				return open ? !!target.closest('aside') : !!target.closest('main') && isChatPage();
			},
			ondrag(offset) {
				clearTimeout(settleTimer);
				settleMs = null;
				dragProgress = offset / window.innerWidth;
			},
			onrelease({ open, durationMs }) {
				dragProgress = null;
				settleMs = durationMs;
				clearTimeout(settleTimer);
				settleTimer = setTimeout(() => (settleMs = null), durationMs + 50);
				const focused = document.activeElement;
				if (!open && focused instanceof HTMLElement && focused.closest('aside')) focused.blur();
				if (open !== mobileOpen) haptic('light');
				mobileOpen = open;
			}
		});
	}

	async function copyLastReply(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied the last reply');
		} catch {
			toast.error('Failed to copy');
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented) return;
		const action = matchShortcut(event, isTypingTarget(event.target));
		if (!action) return;
		switch (action) {
			case 'escape':
				// The sidebar's own fields (search) handle Esc; it shouldn't stop a reply.
				if (inOverlay(event.target)) return;
				if (event.target instanceof Element && event.target.closest('aside')) {
					// Esc in an empty search box goes back to where you were (Ctrl+K, then Esc).
					if (event.target === sidebarSearch && !sidebarSearch.value) {
						event.preventDefault();
						if (!isDesktop.current) mobileOpen = false;
						if (!focusComposer()) sidebarSearch.blur();
					}
					return;
				}
				if (chatShortcuts()?.escape()) event.preventDefault();
				return;
			case 'focus-composer':
				if (inOverlay(event.target)) return;
				if (focusComposer()) event.preventDefault();
				return;
			case 'new-chat':
				if (inOverlay(event.target)) return;
				event.preventDefault();
				void goto(resolve('/')).then(focusComposer);
				return;
			case 'show-shortcuts':
				// Toggles: the same keys close it again, but don't stack it on another modal.
				if (!shortcutsOpen && inOverlay(event.target)) return;
				event.preventDefault();
				shortcutsOpen = !shortcutsOpen;
				return;
			case 'search':
				if (inOverlay(event.target)) return;
				event.preventDefault();
				void focusSearch();
				return;
			case 'toggle-sidebar':
				if (inOverlay(event.target)) return;
				event.preventDefault();
				void toggleSidebar(false);
				return;
			case 'open-settings':
				if (inOverlay(event.target)) return;
				event.preventDefault();
				// Already in settings: stay on the section you're in.
				if (!page.url.pathname.startsWith('/settings')) void goto(resolve('/settings'));
				return;
			case 'previous-chat':
			case 'next-chat':
				if (inOverlay(event.target)) return;
				if (stepConversation(action === 'next-chat' ? 1 : -1)) event.preventDefault();
				return;
			case 'model-picker':
				if (inOverlay(event.target)) return;
				if (modelPicker()?.()) event.preventDefault();
				return;
			case 'copy-last-reply': {
				if (inOverlay(event.target)) return;
				const text = chatShortcuts()?.lastReply();
				if (!text) return;
				event.preventDefault();
				void copyLastReply(text);
				return;
			}
		}
	}

	onMount(() => {
		preloadHaptics();
		document.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });
		const stopEvents = startServerEvents();
		const stopQueueRunner = startMessageQueueRunner();
		const stopDrawerSwipe = drawerTrack ? startDrawerSwipe(drawerTrack) : undefined;
		return () => {
			stopDrawerSwipe?.();
			clearTimeout(settleTimer);
			stopQueueRunner();
			stopEvents();
			document.removeEventListener('scroll', onAnyScroll, { capture: true });
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

<OfflineBanner />

<ShortcutsDialog bind:open={shortcutsOpen} />

<AttentionNotifier
	conversations={data.conversations}
	unreadIds={data.unreadIds}
	triggers={data.settings.notificationTriggers}
/>

<!--
	One persistent structure for both breakpoints, switched with CSS (md:) so the
	page (and e.g. a chat draft) survives crossing 768px and SSR matches either.
	Mobile: a 200%-wide sliding container with sidebar and content side by side.
	Desktop: the wrappers dissolve (display: contents) into an in-flow,
	collapsible sidebar next to a flexible main.
-->
<!-- Starts below the title bar strip of the installed desktop app (--titlebar-height,
     zero elsewhere); the strip above the sidebar takes the sidebar's colour. -->
<div
	class="fixed top-0 left-0 h-(--titlebar-height) w-(--sidebar-width) bg-muted/30 transition-[width] duration-200 max-md:hidden"
	class:border-r={sidebarOpen}
	style:--sidebar-width={sidebarOpen ? '288px' : '0px'}
	aria-hidden="true"
></div>
<div class="flex h-screen overflow-hidden pt-(--titlebar-height)">
	<!-- While a finger drags it, it follows without a transition; letting go settles it
	     open or closed at the finger's speed (settleMs), as iOS does. -->
	<div
		bind:this={drawerTrack}
		class={cn(
			'fixed top-(--titlebar-height) bottom-0 left-0 flex w-[200%] md:contents',
			dragProgress === null && 'transition-transform duration-300 ease-out'
		)}
		style:transform={dragProgress !== null
			? `translate3d(calc(${dragProgress * 50}% - 50%), 0, 0)`
			: mobileOpen
				? 'translateX(0)'
				: 'translateX(-50%)'}
		style:transition-duration={settleMs !== null ? `${settleMs}ms` : undefined}
		style:transition-timing-function={settleMs !== null ? SETTLE_EASING : undefined}
	>
		<div
			class="h-full w-1/2 shrink-0 md:w-(--sidebar-width) md:overflow-hidden md:transition-[width] md:duration-200 max-md:[&>aside]:w-full"
			style:--sidebar-width={sidebarOpen ? '288px' : '0px'}
		>
			<Sidebar
				user={data.user}
				conversations={data.conversations}
				hasMore={data.hasMoreConversations}
				unreadIds={data.unreadIds}
				snoozed={data.snoozed}
				settledCount={data.settledCount}
				autoSettleDays={data.autoSettleDays}
				bind:closeButton={sidebarCloseButton}
				bind:searchInput={sidebarSearch}
				onclose={closeSidebar}
				onshowshortcuts={() => (shortcutsOpen = true)}
				onopenresult={() => void tick().then(focusComposer)}
			/>
		</div>
		<div class="h-full w-1/2 shrink-0 md:contents">
			<!-- Every page starts below a phone's status bar / notch (zero elsewhere). -->
			<main class="relative flex h-full min-w-0 flex-col pt-[env(safe-area-inset-top)] md:flex-1">
				{@render children()}
			</main>
		</div>
	</div>

	<!-- The same ghost icon button as the header's ⋯ and the sidebar's close button. -->
	<Button
		variant="ghost"
		size="icon-sm"
		class={cn(
			// Sits centred in the first row of every page: the 48px chat header on phones,
			// 56px on wider screens. Page titles (PageHeader) line up with it.
			'fixed top-[calc(0.25rem+var(--app-top))] left-[calc(0.375rem+env(safe-area-inset-left))] z-20 size-10 duration-200 md:top-[calc(0.75rem+var(--app-top))] md:left-[calc(1rem+env(safe-area-inset-left))] md:size-8 md:pointer-coarse:top-[calc(0.5rem+var(--app-top))] md:pointer-coarse:left-[calc(0.5rem+env(safe-area-inset-left))] md:pointer-coarse:size-10',
			overContent &&
				'bg-background shadow-sm ring-1 ring-border hover:bg-muted dark:bg-popover dark:shadow-black/40 dark:ring-foreground/15 dark:hover:bg-accent',
			buttonHidden && 'max-md:pointer-events-none max-md:-translate-y-16 max-md:opacity-0',
			mobileOpen && dragProgress === null && 'max-md:hidden',
			sidebarOpen && 'md:hidden'
		)}
		style={dragProgress !== null && !isDesktop.current
			? `opacity: ${1 - Math.min(1, dragProgress * 2)}`
			: undefined}
		bind:ref={sidebarButton}
		tabindex={buttonHidden && !isDesktop.current ? -1 : undefined}
		aria-hidden={buttonHidden && !isDesktop.current ? 'true' : undefined}
		onclick={() => toggleSidebar()}
		aria-label="Open sidebar"
		title="Open sidebar ({shortcutLabel('toggle-sidebar')})"
	>
		<PanelLeftIcon class="size-[18px] md:size-4" strokeWidth={1.75} />
	</Button>
</div>
