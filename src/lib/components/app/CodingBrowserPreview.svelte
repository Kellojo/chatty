<script lang="ts">
	// Watches (and, with control, drives) the browser tabs a coding agent opened
	// in T3 Code. Frames arrive over SSE from Chatty's relay; input is posted back
	// in small ordered batches.
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import {
		MAX_PREVIEW_INPUT_BATCH,
		previewModifiers,
		toPagePoint,
		type CodingPreviewTab,
		type PreviewController,
		type PreviewStreamEvent
	} from '$lib/coding-preview.js';

	let { conversationId, open = $bindable(false) }: { conversationId: string; open?: boolean } =
		$props();

	const TAB_REFRESH_MS = 5000;
	const MAX_RECONNECTS = 3;

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

	const driving = $derived(control?.controller === 'you');

	async function loadTabs(): Promise<void> {
		try {
			const res = await fetch(base);
			const body = (await res.json().catch(() => null)) as {
				tabs?: CodingPreviewTab[];
				message?: string;
			} | null;
			if (!res.ok) throw new Error(body?.message ?? 'Could not load the browser tabs');
			tabs = body?.tabs ?? [];
			tabsError = null;
			if (!tabs.some((t) => t.tabId === selectedTabId)) selectedTabId = tabs[0]?.tabId ?? null;
		} catch (e) {
			tabsError = e instanceof Error ? e.message : 'Could not load the browser tabs';
		}
	}

	// Tab list: loaded on open and refreshed while open, so titles, URLs and new tabs show up.
	$effect(() => {
		if (!open) return;
		void base;
		untrack(() => {
			tabs = null;
			tabsError = null;
			void loadTabs();
		});
		const timer = setInterval(() => void loadTabs(), TAB_REFRESH_MS);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (!urlEditing) urlDraft = selected?.url ?? '';
	});

	// One stream per selected tab while the dialog is open.
	$effect(() => {
		const tabId = selectedTabId;
		const streamBase = base;
		if (!open || !tabId) return;
		let source: EventSource | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let reconnects = 0;
		let stopped = false;

		const connect = () => {
			frame = null;
			viewport = null;
			control = null;
			viewerId = null;
			streamMessage = null;
			const rect = surfaceEl?.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			const params = new URLSearchParams({
				tab: tabId,
				w: String(Math.round(Math.max(rect?.width ?? 1280, 640) * dpr)),
				h: String(Math.round(Math.max(rect?.height ?? 800, 400) * dpr))
			});
			const es = new EventSource(`${streamBase}/stream?${params}`);
			source = es;
			es.addEventListener('frame', (event) => {
				frame = `data:image/jpeg;base64,${(event as MessageEvent<string>).data}`;
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
				return;
			}
			reconnects++;
			streamMessage = 'Reconnecting…';
			retryTimer = setTimeout(connect, 1000 * reconnects);
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
					void loadTabs().then(() => {
						if (tabs?.some((t) => t.tabId === event.tabId)) selectedTabId = event.tabId;
					});
					return;
				case 'end':
					es.close();
					if (source === es) source = null;
					viewerId = null;
					if (event.reason === 'gone') {
						streamMessage = event.message;
						void loadTabs();
					} else if (event.reason === 'restart') {
						retry(event.message);
					} else {
						streamMessage = event.message;
					}
					return;
			}
		};

		untrack(connect);
		return () => {
			stopped = true;
			if (retryTimer) clearTimeout(retryTimer);
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
		<Dialog.Header class="pr-10">
			<Dialog.Title class="flex items-center gap-2">
				<GlobeIcon class="size-4" />
				Browser preview
			</Dialog.Title>
			<Dialog.Description class="sr-only">
				Browser tabs the coding agent opened for this task, streamed from the coding machine.
			</Dialog.Description>
		</Dialog.Header>

		{#if tabs && tabs.length > 1}
			<div class="flex gap-1 overflow-x-auto" role="tablist" aria-label="Browser tabs">
				{#each tabs as tab (tab.tabId)}
					<Button
						variant={tab.tabId === selectedTabId ? 'secondary' : 'ghost'}
						size="sm"
						role="tab"
						aria-selected={tab.tabId === selectedTabId}
						class="max-w-48 shrink-0"
						title={tab.url ?? undefined}
						onclick={() => (selectedTabId = tab.tabId)}
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

		<!-- A remote page: while you drive it, it takes focus and every key, like an embedded app. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			bind:this={surfaceEl}
			class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
					The agent hasn't opened a browser tab for this task. Tabs it opens in T3 Code show up
					here.
				</p>
			{:else if frame}
				<img
					bind:this={imgEl}
					src={frame}
					alt={selected ? `Page: ${tabLabel(selected)}` : 'Browser page'}
					draggable="false"
					class="block h-auto max-h-full w-auto max-w-full select-none {driving
						? 'cursor-default'
						: 'cursor-not-allowed'}"
					onpointerdown={(e) => pointer(e, 'down')}
					onpointerup={(e) => pointer(e, 'up')}
					onpointermove={(e) => pointer(e, 'move')}
					oncontextmenu={(e) => driving && e.preventDefault()}
				/>
			{:else if !streamMessage}
				<LoaderCircleIcon class="size-5 animate-spin text-muted-foreground" />
			{/if}
			{#if streamMessage}
				<p
					class="absolute inset-x-0 bottom-3 mx-auto w-fit max-w-[90%] rounded-md bg-background/90 px-3 py-1.5 text-center text-xs text-muted-foreground shadow"
				>
					{streamMessage}
				</p>
			{/if}
		</div>

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
