<script lang="ts">
	// Renderless: turns server events and the sidebar's unread state into the tab
	// title count/flash, favicon dot, app icon badge, desktop notifications and
	// sounds. Mounted once in the app layout.
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import faviconSvg from '$lib/assets/favicon.svg?raw';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import { devicePrefs } from '$lib/notifications/prefs.svelte.js';
	import { listenForNotificationClicks, showDesktopNotice } from '$lib/notifications/desktop.js';
	import { startPresenceReporter, type PresenceReporter } from '$lib/notifications/presence.js';
	import { syncPushSubscription } from '$lib/notifications/push.js';
	import { playTone, unlockAudioOnGesture } from '$lib/notifications/sound.js';
	import { startTabCoordinator, type TabCoordinator } from '$lib/notifications/tabs.js';
	import {
		ATTENTION_DOT_COLOR,
		NOTICE_LABEL,
		attentionSummary,
		badgedFaviconSvg,
		codingStatusSnapshot,
		composeTitle,
		needsYouNotice,
		newlyNeedingYou,
		noticeForEvent,
		svgDataUrl,
		type Notice
	} from '$lib/notifications/rules.js';
	import type { CodingTaskStatus } from '$lib/coding-environments.js';
	import type { Conversation } from '$lib/types.js';
	import type { NotificationTriggers } from '$lib/user-settings.js';

	let {
		conversations,
		unreadIds,
		triggers
	}: {
		conversations: Conversation[];
		unreadIds: string[];
		triggers: NotificationTriggers;
	} = $props();

	/** Repeats of the same notice within this window (e.g. reply + finished) alert once. */
	const DEDUPE_MS = 3000;
	const FLASH_MS = 1000;
	/** At most this often, re-register this device for push (see resync). */
	const PUSH_RESYNC_MS = 10 * 60_000;

	const prefs = $derived(devicePrefs.current);
	const currentId = $derived(/^\/chat\/([^/]+)/.exec(page.url.pathname)?.[1] ?? null);
	const summary = $derived(attentionSummary(conversations, unreadIds, currentId));

	let mounted = $state(false);
	let hidden = $state(false);
	let flashLabel = $state<string | null>(null);
	let flashOn = $state(false);

	let coordinator: TabCoordinator | null = null;
	let presence: PresenceReporter | null = null;
	// Plain bookkeeping, never rendered.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const recent = new Map<string, number>();

	function navigate(url: string) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- app path from a notice
		void goto(url);
	}

	async function agentName(agentId: string): Promise<string | null> {
		try {
			const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
			if (!res.ok) return null;
			const body = (await res.json()) as { agent?: { name?: string } };
			return body.agent?.name ?? null;
		} catch {
			return null;
		}
	}

	async function raise(notice: Notice) {
		if (!coordinator) return;
		const now = Date.now();
		if (now - (recent.get(notice.tag) ?? 0) < DEDUPE_MS) return;
		recent.set(notice.tag, now);
		// You're already looking at it, in this tab or another.
		if (coordinator.anyVisibleOn(notice.url)) return;

		if (document.hidden && prefs.titleFlash) flashLabel = NOTICE_LABEL[notice.kind];

		if (!coordinator.isLeader()) return;
		const focused = coordinator.anyFocused();
		if (prefs.sound && (!focused || prefs.soundWhenFocused)) playTone(prefs.tone, prefs.volume);
		// With push on too, the server's copy of this notice shares its tag and
		// replaces this popup quietly (static/notification-sw.js).
		if (prefs.desktop && !focused) {
			const title = notice.agentId
				? ((await agentName(notice.agentId)) ?? notice.title)
				: notice.title;
			await showDesktopNotice({ ...notice, title }, navigate).catch(() => undefined);
		}
	}

	// --- Server events -------------------------------------------------------

	onMount(() => {
		devicePrefs.load();
		coordinator = startTabCoordinator();
		hidden = document.hidden;
		mounted = true;

		const onVisibility = () => {
			hidden = document.hidden;
			if (!hidden) flashLabel = null;
		};
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('focus', onVisibility);

		const offEvents = onServerEvent((event) => {
			const notice = noticeForEvent(event, {
				triggers,
				conversation: (id) => conversations.find((c) => c.id === id)
			});
			if (notice) void raise(notice);
		});
		const offClicks = listenForNotificationClicks(navigate);
		const offAudio = unlockAudioOnGesture();
		presence = startPresenceReporter();
		// Re-register on start, and again when back online or back in view, in case
		// the first try failed (offline) while the server had dropped this device.
		let lastSync = 0;
		const resync = () => {
			if (document.visibilityState !== 'visible' || Date.now() - lastSync < PUSH_RESYNC_MS) {
				return;
			}
			lastSync = Date.now();
			void syncPushSubscription().catch(() => (lastSync = 0));
		};
		resync();
		window.addEventListener('online', resync);
		document.addEventListener('visibilitychange', resync);

		return () => {
			window.removeEventListener('online', resync);
			document.removeEventListener('visibilitychange', resync);
			presence?.stop();
			presence = null;
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('focus', onVisibility);
			offEvents();
			offClicks();
			offAudio();
			coordinator?.stop();
			coordinator = null;
		};
	});

	$effect(() => {
		// Let other tabs know which conversation this tab shows.
		void page.url.pathname;
		coordinator?.refresh();
		presence?.refresh();
	});

	// Coding tasks report "waiting for you" only through refreshed list data.
	let codingSnapshot: Map<string, CodingTaskStatus> | null = null;
	$effect(() => {
		const list = conversations;
		if (!mounted) return;
		untrack(() => {
			if (codingSnapshot && triggers.needsYou) {
				for (const c of newlyNeedingYou(codingSnapshot, list)) void raise(needsYouNotice(c));
			}
			codingSnapshot = codingStatusSnapshot(list);
		});
	});

	// --- Tab title -----------------------------------------------------------

	$effect(() => {
		if (!flashLabel || !hidden) {
			flashOn = false;
			return;
		}
		flashOn = true;
		const timer = setInterval(() => (flashOn = !flashOn), FLASH_MS);
		return () => clearInterval(timer);
	});

	// Pages set their own <title>; remember it and decorate it, re-applying when
	// a navigation replaces it.
	let baseTitle = '';
	let writtenTitle = '';

	function renderTitle() {
		if (document.title !== writtenTitle) baseTitle = document.title;
		const next = composeTitle(
			baseTitle,
			prefs.badge ? summary.count : 0,
			flashLabel ? { label: flashLabel, on: flashOn } : null
		);
		writtenTitle = next;
		if (document.title !== next) document.title = next;
	}

	$effect(() => {
		if (!mounted) return;
		renderTitle();
	});

	onMount(() => {
		const observer = new MutationObserver(() => {
			if (document.title !== writtenTitle) renderTitle();
		});
		observer.observe(document.head, { childList: true, subtree: true, characterData: true });
		return () => {
			observer.disconnect();
			if (baseTitle) document.title = baseTitle;
		};
	});

	// --- Favicon dot and app icon badge ---------------------------------------

	let originalFavicon: string | null = null;

	$effect(() => {
		if (!mounted) return;
		const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
		if (!link) return;
		originalFavicon ??= link.href;
		link.href =
			prefs.badge && summary.level !== 'none'
				? svgDataUrl(badgedFaviconSvg(faviconSvg, ATTENTION_DOT_COLOR[summary.level]))
				: originalFavicon;
	});

	$effect(() => {
		if (!mounted) return;
		const nav = navigator as Navigator & {
			setAppBadge?: (count?: number) => Promise<void>;
			clearAppBadge?: () => Promise<void>;
		};
		if (!nav.setAppBadge || !nav.clearAppBadge) return;
		const request =
			prefs.badge && summary.count > 0 ? nav.setAppBadge(summary.count) : nav.clearAppBadge();
		void request.catch(() => undefined);
	});

	onMount(() => () => {
		const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
		if (link && originalFavicon) link.href = originalFavicon;
	});
</script>
