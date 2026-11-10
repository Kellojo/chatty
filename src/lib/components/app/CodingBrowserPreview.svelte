<script lang="ts">
	// Watches (and, with control, drives) the browser tabs a coding agent opened
	// in T3 Code. Frames arrive over SSE from Chatty's relay; input is posted back
	// in small ordered batches.
	//
	// One stream feeds two views: the full dialog, and on desktop a small
	// picture-in-picture in the bottom right that opens while the agent uses
	// the browser during a run.
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import PictureInPicture2Icon from '@lucide/svelte/icons/picture-in-picture-2';
	import XIcon from '@lucide/svelte/icons/x';
	import {
		MAX_PREVIEW_INPUT_BATCH,
		fitSize,
		previewModifiers,
		toPagePoint,
		type CodingBrowserActivity,
		type CodingPreviewTab,
		type PreviewController,
		type PreviewStreamEvent
	} from '$lib/coding-preview.js';

	let {
		conversationId,
		open = $bindable(false),
		activity = null
	}: {
		conversationId: string;
		open?: boolean;
		/** The agent's browser use in the current run; null when no run is using it. */
		activity?: CodingBrowserActivity | null;
	} = $props();

	const TAB_REFRESH_MS = 5000;
	const MAX_RECONNECTS = 3;
	/** Frames are re-requested once the view needs this much more resolution than it asked for. */
	const UPSIZE_FACTOR = 1.2;
	const UPSIZE_DEBOUNCE_MS = 400;
	/** T3 only draws a tab it shows; say so when frames don't come. */
	const NO_FRAME_HINT_MS = 8000;
	/** Where the picture-in-picture makes sense: a wide screen with a mouse. */
	const PIP_MEDIA = '(min-width: 1024px) and (pointer: fine)';

	/** The small floating view; the dialog takes over while it's open. */
	let pip = $state(false);
	/** The run whose picture-in-picture was closed, so the agent's next call doesn't reopen it. */
	let dismissedRun: string | null = null;
	let lastCalls = 0;
	const showPip = $derived(pip && !open);
	/** Whether a view is showing, so the tabs and stream are live. */
	const active = $derived(open || pip);

	// Opens the picture-in-picture when the agent uses its browser again, and
	// closes it when the run ends.
	$effect(() => {
		const current = activity;
		untrack(() => {
			if (!current) {
				pip = false;
				lastCalls = 0;
				return;
			}
			const used = current.calls > lastCalls;
			lastCalls = current.calls;
			if (!used || open || dismissedRun === current.run) return;
			if (!window.matchMedia(PIP_MEDIA).matches) return;
			if (current.tabId) {
				wantedTabId = current.tabId;
				if (tabs?.some((t) => t.tabId === current.tabId)) selectedTabId = current.tabId;
			}
			pip = true;
		});
	});

	function closePip(): void {
		pip = false;
		dismissedRun = activity?.run ?? null;
	}

	function expandPip(): void {
		pip = false;
		open = true;
	}

	function minimize(): void {
		pip = true;
		dismissedRun = null;
		open = false;
	}

	const base = $derived(`/api/coding/tasks/${encodeURIComponent(conversationId)}/preview`);

	let tabs = $state<CodingPreviewTab[] | null>(null);
	let tabsError = $state<string | null>(null);
	let selectedTabId = $state<string | null>(null);
	const selected = $derived(tabs?.find((t) => t.tabId === selectedTabId) ?? null);

	let frame = $state<string | null>(null);
	let viewport = $state<{ width: number; height: number } | null>(null);
	let control = $state<{ canOperate: boolean; controller: PreviewController } | null>(null);
	let streamMessage = $state<string | null>(null);
	let viewerId: string | null = null;
	let urlDraft = $state('');
	let urlEditing = $state(false);

	let imgEl = $state<HTMLImageElement | null>(null);
	let surfaceEl = $state<HTMLDivElement | null>(null);

	/** Whether your input goes to the page, from the dialog or the picture-in-picture. */
	const driving = $derived(control?.controller === 'you');

	/** Bumped per tab-list request, so only the latest response applies. */
	let tabsSeq = 0;
	/** A popup to switch to once the tab list includes it. */
	let wantedTabId: string | null = null;
	/** Bumped by the Reconnect button to restart a stream that gave up. */
	let reconnectNonce = $state(0);
	let streamDead = $state(false);

	/** `signal` is aborted when the dialog closes, so late responses are dropped. */
	async function loadTabs(signal: AbortSignal): Promise<void> {
		const seq = ++tabsSeq;
		try {
			const res = await fetch(base, { signal });
			const body = (await res.json().catch(() => null)) as {
				tabs?: CodingPreviewTab[];
				message?: string;
			} | null;
			if (signal.aborted || seq !== tabsSeq) return;
			if (!res.ok) throw new Error(body?.message ?? 'Could not load the browser tabs');
			const next = body?.tabs ?? [];
			tabs = next;
			tabsError = null;
			if (wantedTabId && next.some((t) => t.tabId === wantedTabId)) {
				selectedTabId = wantedTabId;
				wantedTabId = null;
			} else if (!next.some((t) => t.tabId === selectedTabId)) {
				selectedTabId = next[0]?.tabId ?? null;
			}
		} catch (e) {
			if (signal.aborted || seq !== tabsSeq) return;
			tabsError = e instanceof Error ? e.message : 'Could not load the browser tabs';
		}
	}

	// Tab list: loaded on open and refreshed while open (and visible), so titles,
	// URLs and new tabs show up.
	$effect(() => {
		if (!active) return;
		void base;
		const controller = new AbortController();
		untrack(() => {
			tabs = null;
			tabsError = null;
			void loadTabs(controller.signal);
		});
		const timer = setInterval(() => {
			if (!document.hidden) void loadTabs(controller.signal);
		}, TAB_REFRESH_MS);
		const onVisible = () => {
			if (!document.hidden) void loadTabs(controller.signal);
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			controller.abort();
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
			wantedTabId = null;
		};
	});

	$effect(() => {
		if (!urlEditing) urlDraft = selected?.url ?? '';
	});

	/**
	 * Frame pixels per CSS pixel. At least 2: T3 renders pages at 2x, and
	 * downscaling a sharper frame keeps text crisp on 1x screens too.
	 */
	function frameScale(): number {
		return Math.max(window.devicePixelRatio || 1, 2);
	}

	/** The view's layout size in CSS pixels (untransformed, so the dialog's zoom-in doesn't shrink it). */
	let box = $state<{ width: number; height: number } | null>(null);
	$effect(() => {
		const el = surfaceEl;
		if (!el) return;
		const measure = () => (box = { width: el.clientWidth, height: el.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	});

	/** The last frame's pixel size, for when T3 hasn't reported the page's size. */
	let frameSize = $state<{ width: number; height: number } | null>(null);
	/** The page's size; frames vary in resolution (T3 halves them while scrolling). */
	const pageSize = $derived(viewport ?? frameSize);
	/** The frame shown fitted to the view, whatever resolution it arrived in. */
	const display = $derived(pageSize && box ? fitSize(pageSize, box) : null);

	/** The frame size the open stream asked for, in device pixels. */
	let requested: { width: number; height: number } | null = null;
	/** Bumped to reopen the stream at a higher resolution, keeping the current frame up meanwhile. */
	let upsizeNonce = $state(0);
	let handledUpsize = 0;
	let noFrameHint = $state(false);

	// The view grew (window resized, picture-in-picture expanded): ask for sharper frames.
	$effect(() => {
		const shown = display;
		if (!shown || !requested || !pageSize) return;
		const dpr = frameScale();
		// T3 fits the page into the requested box, so only the binding side counts.
		const deliverable = fitSize(pageSize, requested);
		if (shown.width * dpr <= deliverable.width * UPSIZE_FACTOR) return;
		const timer = setTimeout(() => upsizeNonce++, UPSIZE_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	// One stream per selected tab while a view is showing.
	$effect(() => {
		const tabId = selectedTabId;
		const streamBase = base;
		void reconnectNonce;
		const upsizing = upsizeNonce !== handledUpsize;
		handledUpsize = upsizeNonce;
		if (!active || !tabId) return;
		const controller = new AbortController();
		let source: EventSource | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let hintTimer: ReturnType<typeof setTimeout> | null = null;
		let reconnects = 0;
		let stopped = false;

		const connect = (keepFrame = false) => {
			if (!keepFrame) {
				frame = null;
				frameSize = null;
				viewport = null;
			}
			control = null;
			viewerId = null;
			streamMessage = null;
			streamDead = false;
			noFrameHint = false;
			const dpr = frameScale();
			requested = {
				width: Math.round(Math.max(surfaceEl?.clientWidth || 1280, 640) * dpr),
				height: Math.round(Math.max(surfaceEl?.clientHeight || 800, 400) * dpr)
			};
			const params = new URLSearchParams({
				tab: tabId,
				w: String(requested.width),
				h: String(requested.height)
			});
			const es = new EventSource(`${streamBase}/stream?${params}`);
			source = es;
			if (hintTimer) clearTimeout(hintTimer);
			hintTimer = setTimeout(() => {
				if (source === es && frame === null) noFrameHint = true;
			}, NO_FRAME_HINT_MS);
			es.addEventListener('frame', (event) => {
				frame = `data:image/jpeg;base64,${(event as MessageEvent<string>).data}`;
				noFrameHint = false;
				reconnects = 0;
			});
			es.addEventListener('state', (event) => {
				let parsed: PreviewStreamEvent;
				try {
					parsed = JSON.parse((event as MessageEvent<string>).data) as PreviewStreamEvent;
				} catch {
					return;
				}
				onStreamEvent(parsed, es);
			});
			// The server ends the stream with an `end` event; anything else is a dropped
			// connection. EventSource would reconnect on its own, without our backoff.
			es.onerror = () => {
				if (source !== es) return;
				es.close();
				source = null;
				retry('Lost the connection to the preview');
			};
		};

		const retry = (message: string) => {
			if (stopped) return;
			viewerId = null;
			if (reconnects >= MAX_RECONNECTS) {
				streamMessage = message;
				streamDead = true;
				return;
			}
			reconnects++;
			streamMessage = 'Reconnecting…';
			retryTimer = setTimeout(() => connect(), 1000 * reconnects);
		};

		const onStreamEvent = (event: PreviewStreamEvent, es: EventSource) => {
			switch (event.type) {
				case 'ready':
					viewerId = event.viewerId;
					return;
				case 'viewport':
					viewport = { width: event.width, height: event.height };
					return;
				case 'control':
					control = { canOperate: event.canOperate, controller: event.controller };
					return;
				case 'popup':
					wantedTabId = event.tabId;
					void loadTabs(controller.signal);
					return;
				case 'end':
					es.close();
					if (source === es) source = null;
					viewerId = null;
					if (event.reason === 'gone') {
						streamMessage = event.message;
						void loadTabs(controller.signal);
					} else if (event.reason === 'restart') {
						retry(event.message);
					} else {
						streamMessage = event.message;
						streamDead = true;
					}
					return;
			}
		};

		untrack(() => connect(upsizing && frame !== null));
		return () => {
			stopped = true;
			controller.abort();
			if (retryTimer) clearTimeout(retryTimer);
			if (hintTimer) clearTimeout(hintTimer);
			source?.close();
			source = null;
			viewerId = null;
			queue.length = 0;
		};
	});

	// Input: one request in flight at a time keeps order; queued mouse moves coalesce.
	const queue: Record<string, unknown>[] = [];
	let sending = false;

	function send(message: Record<string, unknown>): void {
		if (!viewerId) return;
		const last = queue.at(-1);
		if (
			message.type === 'mouse' &&
			message.action === 'move' &&
			last?.type === 'mouse' &&
			last.action === 'move' &&
			last.buttons === message.buttons
		) {
			queue[queue.length - 1] = message;
		} else {
			queue.push(message);
		}
		void flush();
	}

	async function flush(): Promise<void> {
		if (sending) return;
		sending = true;
		try {
			while (queue.length > 0 && viewerId) {
				const id = viewerId;
				const messages = queue.splice(0, MAX_PREVIEW_INPUT_BATCH);
				const res = await fetch(`${base}/input`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ viewerId: id, messages })
				}).catch(() => null);
				if (res?.status === 410 && viewerId === id) viewerId = null;
			}
		} finally {
			sending = false;
			queue.length = viewerId ? queue.length : 0;
		}
	}

	function pagePoint(event: MouseEvent): { x: number; y: number } | null {
		if (!imgEl) return null;
		const size = viewport ?? { width: imgEl.naturalWidth, height: imgEl.naturalHeight };
		if (!size.width || !size.height) return null;
		return toPagePoint(event.clientX, event.clientY, imgEl.getBoundingClientRect(), size);
	}

	const BUTTONS = ['left', 'middle', 'right'] as const;

	function pointer(event: PointerEvent, action: 'down' | 'up' | 'move'): void {
		if (!driving) return;
		const point = pagePoint(event);
		if (!point) return;
		if (action === 'down') {
			surfaceEl?.focus();
			imgEl?.setPointerCapture(event.pointerId);
		}
		event.preventDefault();
		send({
			type: 'mouse',
			action,
			...point,
			button: action === 'move' ? 'none' : (BUTTONS[event.button] ?? 'none'),
			buttons: event.buttons,
			clickCount: action === 'move' ? 0 : Math.max(event.detail, 1),
			modifiers: previewModifiers(event)
		});
	}

	// Registered by hand: Svelte's wheel handlers are passive and can't stop the dialog scrolling.
	$effect(() => {
		const el = imgEl;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			if (!driving) return;
			const point = pagePoint(event);
			if (!point) return;
			event.preventDefault();
			const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
			send({
				type: 'wheel',
				...point,
				deltaX: event.deltaX * scale,
				deltaY: event.deltaY * scale,
				modifiers: previewModifiers(event)
			});
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	});

	function key(event: KeyboardEvent, action: 'down' | 'up'): void {
		if (!driving || event.isComposing) return;
		const modifiers = previewModifiers(event);
		// Let the browser keep paste (it arrives as a paste event) and Escape closes the dialog.
		if (event.key === 'Escape') return;
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
		event.preventDefault();
		const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
		send({
			type: 'key',
			action,
			key: event.key,
			code: event.code,
			...(action === 'down' && printable ? { text: event.key } : {}),
			...(action === 'down' && event.key === 'Enter' ? { text: '\r' } : {}),
			keyCode: event.keyCode,
			modifiers
		});
	}

	function paste(event: ClipboardEvent): void {
		if (!driving) return;
		const text = event.clipboardData?.getData('text/plain');
		if (!text) return;
		event.preventDefault();
		send({ type: 'text', text });
	}

	function navigate(event: SubmitEvent): void {
		event.preventDefault();
		let url = urlDraft.trim();
		if (!url) return;
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
		send({ type: 'navigate', url });
		urlEditing = false;
		(document.activeElement as HTMLElement | null)?.blur();
	}

	const CONTROLLER_LABEL: Record<PreviewController, string> = {
		you: 'You are in control',
		agent: 'The agent is using this tab',
		'another-viewer': 'Someone else is in control',
		unclaimed: 'Watching'
	};

	function tabLabel(tab: CodingPreviewTab): string {
		if (tab.title) return tab.title;
		if (!tab.url) return 'New tab';
		try {
			return new URL(tab.url).host || tab.url;
		} catch {
			return tab.url;
		}
	}
</script>

{#snippet surface(sizing: string)}
	<!-- A remote page: while you drive it, it takes focus and every key, like an embedded app. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		bind:this={surfaceEl}
		class="relative flex min-h-0 {sizing} items-center justify-center overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
		role="application"
		aria-label="Browser page"
		tabindex={driving ? 0 : -1}
		onkeydown={(e) => key(e, 'down')}
		onkeyup={(e) => key(e, 'up')}
		onpaste={paste}
	>
		{#if tabsError}
			<p class="px-6 text-center text-sm text-muted-foreground">{tabsError}</p>
		{:else if tabs === null}
			<LoaderCircleIcon class="size-5 animate-spin text-muted-foreground" />
		{:else if tabs.length === 0}
			<p class="max-w-sm px-6 text-center text-sm text-muted-foreground">
				The agent hasn't opened a browser tab for this task. Tabs it opens in T3 Code show up here.
			</p>
		{:else if frame}
			<img
				bind:this={imgEl}
				src={frame}
				alt={selected ? `Page: ${tabLabel(selected)}` : 'Browser page'}
				draggable="false"
				style:width={display ? `${display.width}px` : undefined}
				style:height={display ? `${display.height}px` : undefined}
				class="block max-h-full max-w-full object-contain select-none {driving
					? 'cursor-default'
					: open
						? 'cursor-not-allowed'
						: ''}"
				onload={() => {
					const img = imgEl;
					if (
						img &&
						(frameSize?.width !== img.naturalWidth || frameSize?.height !== img.naturalHeight)
					) {
						frameSize = { width: img.naturalWidth, height: img.naturalHeight };
					}
				}}
				data-no-swipe={driving ? '' : undefined}
				onpointerdown={(e) => pointer(e, 'down')}
				onpointerup={(e) => pointer(e, 'up')}
				onpointermove={(e) => pointer(e, 'move')}
				oncontextmenu={(e) => driving && e.preventDefault()}
			/>
		{:else if !streamMessage}
			<LoaderCircleIcon class="size-5 animate-spin text-muted-foreground" />
		{/if}
		{#if noFrameHint && !frame && !streamMessage}
			<p
				class="absolute inset-x-0 bottom-3 mx-auto w-fit max-w-[90%] rounded-md bg-background/90 px-3 py-1.5 text-center text-xs text-muted-foreground shadow"
				role="status"
			>
				Waiting for the coding machine to draw this tab. T3 Code only streams tabs it shows.
			</p>
		{/if}
		{#if streamMessage}
			<div
				class="absolute inset-x-0 bottom-3 mx-auto flex w-fit max-w-[90%] items-center gap-2 rounded-md bg-background/90 px-3 py-1.5 text-center text-xs text-muted-foreground shadow"
				role="status"
			>
				<span>{streamMessage}</span>
				{#if streamDead}
					<Button
						variant="outline"
						size="xs"
						onclick={() => {
							streamDead = false;
							reconnectNonce++;
						}}
					>
						<RotateCwIcon />
						Reconnect
					</Button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex h-[calc(100dvh-2rem)] max-h-[60rem] w-full max-w-[calc(100vw-2rem)] flex-col gap-3 p-4 sm:max-w-6xl"
		onEscapeKeydown={(event) => {
			// While you drive the page, Escape belongs to it; close with the button.
			if (driving && document.activeElement === surfaceEl) {
				event.preventDefault();
				send({ type: 'key', action: 'down', key: 'Escape', code: 'Escape', keyCode: 27 });
				send({ type: 'key', action: 'up', key: 'Escape', code: 'Escape', keyCode: 27 });
			}
		}}
	>
		<Dialog.Header class="flex-row items-center gap-2 pr-10">
			<Dialog.Title class="flex flex-1 items-center gap-2">
				<GlobeIcon class="size-4" />
				Browser preview
			</Dialog.Title>
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-muted-foreground hover:text-foreground max-lg:hidden"
				title="Picture in picture"
				aria-label="Keep watching in a small window"
				onclick={minimize}
			>
				<PictureInPicture2Icon />
			</Button>
			<Dialog.Description class="sr-only">
				Browser tabs the coding agent opened for this task, streamed from the coding machine.
			</Dialog.Description>
		</Dialog.Header>

		{#if tabs && tabs.length > 1}
			<div class="flex gap-1 overflow-x-auto" role="group" aria-label="Browser tabs">
				{#each tabs as tab (tab.tabId)}
					<Button
						variant={tab.tabId === selectedTabId ? 'secondary' : 'ghost'}
						size="sm"
						aria-pressed={tab.tabId === selectedTabId}
						class="max-w-48 shrink-0"
						title={tab.url ?? undefined}
						onclick={() => {
							wantedTabId = null;
							selectedTabId = tab.tabId;
						}}
					>
						<span class="truncate">{tabLabel(tab)}</span>
					</Button>
				{/each}
			</div>
		{/if}

		{#if selected}
			<div class="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Back"
					title="Back"
					disabled={!driving || !selected.canGoBack}
					onclick={() => send({ type: 'history', delta: -1 })}
				>
					<ArrowLeftIcon />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Forward"
					title="Forward"
					disabled={!driving || !selected.canGoForward}
					onclick={() => send({ type: 'history', delta: 1 })}
				>
					<ArrowRightIcon />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Reload"
					title="Reload"
					disabled={!driving}
					onclick={() => send({ type: 'reload' })}
				>
					<RotateCwIcon />
				</Button>
				<form class="min-w-0 flex-1" onsubmit={navigate}>
					<Input
						bind:value={urlDraft}
						readonly={!driving}
						aria-label="Address"
						class="h-8 font-mono text-xs"
						spellcheck={false}
						autocomplete="off"
						onfocus={() => (urlEditing = true)}
						onblur={() => (urlEditing = false)}
					/>
				</form>
				{#if control?.canOperate}
					{#if driving}
						<Button variant="outline" size="sm" onclick={() => send({ type: 'releaseControl' })}>
							Release
						</Button>
					{:else}
						<Button variant="outline" size="sm" onclick={() => send({ type: 'takeControl' })}>
							Take control
						</Button>
					{/if}
				{/if}
			</div>
		{/if}

		{@render surface('flex-1')}

		{#if control}
			<p class="text-xs text-muted-foreground">
				{CONTROLLER_LABEL[control.controller]}{#if !control.canOperate}
					· View only. Re-pair this coding environment in Settings to click and type in its browser
					tabs.
				{:else if driving}
					· Click the page to type into it.
				{/if}
			</p>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<!-- Watches the tab; take control to click and type in it, or expand it for the toolbar. -->
{#if showPip}
	<section
		class="fixed right-4 bottom-4 z-40 flex w-[22rem] flex-col overflow-hidden rounded-xl border bg-background shadow-lg max-lg:hidden"
		aria-label="Browser preview"
	>
		<header class="flex items-center gap-1 py-1 pr-1 pl-3 text-xs text-muted-foreground">
			<GlobeIcon class="size-3.5 shrink-0" />
			<span class="min-w-0 flex-1 truncate" title={selected?.url ?? undefined}>
				{selected ? tabLabel(selected) : 'Browser preview'}
			</span>
			{#if control?.canOperate}
				<Button
					variant={driving ? 'secondary' : 'ghost'}
					size="xs"
					title={driving ? 'Hand the tab back' : 'Click and type in this tab'}
					onclick={() => send({ type: driving ? 'releaseControl' : 'takeControl' })}
				>
					{driving ? 'Release' : 'Take control'}
				</Button>
			{/if}
			<Button
				variant="ghost"
				size="icon-sm"
				title="Expand"
				aria-label="Open the full browser preview"
				onclick={expandPip}
			>
				<Maximize2Icon />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				title="Close"
				aria-label="Close the picture in picture"
				onclick={closePip}
			>
				<XIcon />
			</Button>
		</header>
		<!-- Watching, the frame is a big target for expanding (the header's Expand button is the
		     keyboard route); in control, it's the page. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="max-h-[50vh] p-1 pt-0 {driving ? '' : 'cursor-pointer'}"
			style:aspect-ratio={pageSize ? `${pageSize.width} / ${pageSize.height}` : '16 / 10'}
			onclick={(event) => {
				// Buttons inside the frame (Reconnect) do their own thing.
				if (!driving && !(event.target as Element).closest('button')) expandPip();
			}}
		>
			{@render surface('size-full')}
		</div>
	</section>
{/if}
