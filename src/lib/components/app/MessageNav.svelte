<script lang="ts">
	import { cn } from '$lib/utils.js';

	export type MessageNavItem = { id: string; text: string };

	let {
		items,
		scrollEl,
		onjump,
		class: className
	}: {
		/** The user messages to mark, oldest first; each is found by `data-message-id`. */
		items: MessageNavItem[];
		scrollEl: HTMLElement | null;
		/** Called before jumping, so the container stops following new output. */
		onjump?: () => void;
		class?: string;
	} = $props();

	/** Gap kept above a message when jumping to it. */
	const JUMP_MARGIN = 16;
	/** Height of the fade at each end of an overflowing rail. */
	const RAIL_FADE = 16;
	/** Ticks moved by PageUp / PageDown. */
	const PAGE_STEP = 10;
	const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

	let activeId = $state<string | null>(null);
	let hovered = $state<{ item: MessageNavItem; top: number } | null>(null);
	let root = $state<HTMLElement | null>(null);
	let list = $state<HTMLElement | null>(null);

	// Looked up once each, not on every scroll frame; dropped when the list changes.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain cache, nothing renders from it
	const messageEls = new Map<string, HTMLElement>();

	function findMessage(id: string): HTMLElement | null {
		const cached = messageEls.get(id);
		if (cached?.isConnected) return cached;
		const el = scrollEl?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
		if (el) messageEls.set(id, el);
		return el ?? null;
	}

	/**
	 * The message just jumped to. It stays active until that scroll settles, so
	 * the highlight doesn't run through every tick on the way or land on a
	 * neighbour that also crossed the line.
	 */
	let pinnedId: string | null = null;
	let unpinTimer: ReturnType<typeof setTimeout> | undefined;

	let pinnedScroller: HTMLElement | null = null;

	/** The message a jump is heading to; flashed once the scroll settles. */
	let landing: HTMLElement | null = null;

	function unpin() {
		clearTimeout(unpinTimer);
		const landed = landing;
		landing = null;
		if (landed && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
			// A ring around the bubble itself, fading out: "you are here".
			const bubble = landed.querySelector<HTMLElement>('[data-message-bubble]') ?? landed;
			bubble.animate(
				[{ boxShadow: '0 0 0 2px var(--ring)' }, { boxShadow: '0 0 0 2px transparent' }],
				{ duration: 1200, easing: 'ease-in' }
			);
		}
		pinnedScroller?.removeEventListener('scrollend', unpin);
		pinnedScroller = null;
		pinnedId = null;
	}

	/** The last message whose top has passed the upper third of the view. */
	function updateActive() {
		const el = scrollEl;
		if (pinnedId && items.some((item) => item.id === pinnedId)) {
			activeId = pinnedId;
			return;
		}
		if (!el || items.length === 0) {
			activeId = null;
			return;
		}
		const box = el.getBoundingClientRect();
		const line = box.top + box.height / 3;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
		let current: string | null = items[0].id;
		for (const item of items) {
			const msg = findMessage(item.id);
			if (!msg) continue;
			const top = msg.getBoundingClientRect().top;
			if (top <= line || (atBottom && top < box.bottom)) current = item.id;
			else break;
		}
		activeId = current;
	}

	// Keyed on the ids: streamed text makes a new `items` on every token.
	const itemIds = $derived(items.map((item) => item.id).join(' '));

	$effect(() => {
		const el = scrollEl;
		void itemIds;
		messageEls.clear();
		if (!el) return;
		let frame = 0;
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(() => ((frame = 0), updateActive()));
		};
		schedule();
		el.addEventListener('scroll', schedule, { passive: true });
		// The user taking over the scroll ends a jump's pin.
		const release = () => {
			if (!pinnedId) return;
			landing = null;
			unpin();
			schedule();
		};
		// Tab or Shift after landing on the message isn't taking over the scroll.
		const releaseOnScrollKey = (e: KeyboardEvent) => {
			if (SCROLL_KEYS.has(e.key)) release();
		};
		const passive = { passive: true } as const;
		el.addEventListener('wheel', release, passive);
		el.addEventListener('touchstart', release, passive);
		el.addEventListener('keydown', releaseOnScrollKey);
		const resize = new ResizeObserver(schedule);
		resize.observe(el);
		// Content can grow without a scroll event: images loading, older pages arriving.
		if (el.firstElementChild) resize.observe(el.firstElementChild);
		return () => {
			cancelAnimationFrame(frame);
			el.removeEventListener('scroll', schedule);
			el.removeEventListener('wheel', release);
			el.removeEventListener('touchstart', release);
			el.removeEventListener('keydown', releaseOnScrollKey);
			unpin();
			resize.disconnect();
		};
	});

	function tickFor(id: string): HTMLElement | null {
		return list?.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(id)}"]`) ?? null;
	}

	// Keep the active tick in sight when the rail itself has to scroll. Moved by
	// hand: scrollIntoView could also scroll the chat and cut its own jump short.
	$effect(() => {
		const id = activeId;
		const rail = list;
		if (!id || !rail) return;
		const tick = tickFor(id);
		if (!tick) return;
		// Clear of the faded ends, where the highlight would be washed out.
		const top = tick.offsetTop - RAIL_FADE;
		const bottom = tick.offsetTop + tick.offsetHeight + RAIL_FADE;
		if (top < rail.scrollTop) rail.scrollTop = top;
		else if (bottom > rail.scrollTop + rail.clientHeight)
			rail.scrollTop = bottom - rail.clientHeight;
	});

	/** The tick last focused, so Tab comes back to where arrowing left off. */
	let focusedId = $state<string | null>(null);
	/** The one tick reachable with Tab; arrows move between the rest. */
	const focusId = $derived(
		(focusedId && items.some((item) => item.id === focusedId) ? focusedId : null) ??
			activeId ??
			items[0]?.id ??
			null
	);

	function onRailKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			// Only swallowed when it closed something; otherwise it's the page's to handle.
			if (hovered) e.stopPropagation();
			hidePreview();
			return;
		}
		const current = (e.target as HTMLElement).closest<HTMLElement>('[data-nav-id]')?.dataset.navId;
		const index = items.findIndex((item) => item.id === current);
		if (index === -1) return;
		const next =
			e.key === 'ArrowUp'
				? index - 1
				: e.key === 'ArrowDown'
					? index + 1
					: e.key === 'PageUp'
						? index - PAGE_STEP
						: e.key === 'PageDown'
							? index + PAGE_STEP
							: e.key === 'Home'
								? 0
								: e.key === 'End'
									? items.length - 1
									: null;
		if (next === null) return;
		e.preventDefault();
		const target = items[Math.max(0, Math.min(items.length - 1, next))];
		tickFor(target.id)?.focus();
	}

	function jump(id: string) {
		const el = scrollEl;
		const msg = findMessage(id);
		if (!el || !msg) return;
		onjump?.();
		hidePreview();
		unpin();
		pinnedId = id;
		activeId = id;
		const top =
			msg.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - JUMP_MARGIN;
		const target = Math.min(Math.max(0, top), el.scrollHeight - el.clientHeight);
		landing = msg;
		if (Math.abs(target - el.scrollTop) < 2) {
			// Already there: no scroll, so no scrollend to wait for.
			requestAnimationFrame(unpin);
		} else {
			const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
			el.scrollTo({ top: target, behavior: reduce ? 'auto' : 'smooth' });
			// Unpinned once the scroll ends; the timer covers a scroll that gets cut short.
			unpinTimer = setTimeout(unpin, 1500);
			pinnedScroller = el;
			el.addEventListener('scrollend', unpin);
		}
		// Take focus along, so reading (and Tab) carries on from that message.
		msg.tabIndex = -1;
		msg.addEventListener('blur', () => msg.removeAttribute('tabindex'), { once: true });
		msg.focus({ preventScroll: true });
	}

	function showPreview(item: MessageNavItem, target: HTMLElement) {
		clearTimeout(previewTimer);
		if (!root) return;
		const tickBox = target.getBoundingClientRect();
		hovered = { item, top: tickBox.top + tickBox.height / 2 - root.getBoundingClientRect().top };
	}

	/** Waits a moment before the first preview, so sweeping past the rail doesn't flash one. */
	const PREVIEW_DELAY = 80;
	let previewTimer: ReturnType<typeof setTimeout> | undefined;

	function hoverPreview(item: MessageNavItem, target: HTMLElement) {
		clearTimeout(previewTimer);
		if (hovered) showPreview(item, target);
		else previewTimer = setTimeout(() => showPreview(item, target), PREVIEW_DELAY);
	}

	function hidePreview() {
		clearTimeout(previewTimer);
		hovered = null;
	}

	const hoveredPosition = $derived(
		hovered ? items.findIndex((item) => item.id === hovered?.item.id) + 1 : 0
	);

	$effect(() => () => {
		clearTimeout(previewTimer);
		clearTimeout(unpinTimer);
	});

	// Fade the rail's ends while ticks are scrolled out of sight past them.
	let fadeTop = $state(false);
	let fadeBottom = $state(false);

	function updateFades() {
		const rail = list;
		if (!rail) return;
		fadeTop = rail.scrollTop > 1;
		fadeBottom = rail.scrollTop + rail.clientHeight < rail.scrollHeight - 1;
	}

	$effect(() => {
		const rail = list;
		void itemIds;
		if (!rail) return;
		updateFades();
		const resize = new ResizeObserver(updateFades);
		resize.observe(rail);
		return () => resize.disconnect();
	});

	const railMask = $derived(
		fadeTop || fadeBottom
			? `linear-gradient(to bottom, ${fadeTop ? 'transparent' : '#000'}, #000 ${RAIL_FADE}px, #000 calc(100% - ${RAIL_FADE}px), ${fadeBottom ? 'transparent' : '#000'})`
			: undefined
	);

	function previewText(text: string): string {
		const flat = text.replace(/\s+/g, ' ').trim();
		return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat || 'Attachment';
	}
</script>

{#if items.length > 1}
	<nav
		bind:this={root}
		aria-label="Your messages"
		class={cn('pointer-events-none absolute top-1/2 left-2 z-10 -translate-y-1/2', className)}
		onmouseleave={() => {
			// A keyboard-focused tick keeps its preview; it closes on blur instead.
			if (!root?.querySelector(':focus-visible')) hidePreview();
			else clearTimeout(previewTimer);
		}}
	>
		<!-- The preview is placed against a tick; scrolling the rail would leave it behind. -->
		<ol
			bind:this={list}
			onfocusout={(e) => {
				// Leaving the rail forgets the last tick, so Tab returns to where the reader is.
				if (!list?.contains(e.relatedTarget as Node | null)) focusedId = null;
			}}
			onscroll={() => {
				hidePreview();
				updateFades();
			}}
			style:mask-image={railMask}
			class="pointer-events-auto flex max-h-[min(60vh,32rem)] [scrollbar-width:none] flex-col overflow-y-auto py-1 [&::-webkit-scrollbar]:hidden"
		>
			{#each items as item, i (item.id)}
				{@const active = item.id === activeId}
				<li>
					<button
						type="button"
						data-nav-id={item.id}
						aria-label={`Message ${i + 1} of ${items.length}: ${previewText(item.text)}`}
						aria-current={active ? 'location' : undefined}
						tabindex={item.id === focusId ? 0 : -1}
						class="group flex h-4 w-9 items-center rounded-full px-2 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
						onclick={() => jump(item.id)}
						onkeydown={onRailKeydown}
						onmouseenter={(e) => hoverPreview(item, e.currentTarget)}
						onfocus={(e) => {
							focusedId = item.id;
							showPreview(item, e.currentTarget);
						}}
						onblur={() => {
							// The pointer may still be resting on the rail; mouseleave closes it then.
							if (!root?.matches(':hover')) hidePreview();
						}}
					>
						<span
							class={cn(
								'rounded-full transition-all duration-150 motion-reduce:transition-none',
								active
									? 'h-[3px] w-5 bg-foreground'
									: 'h-0.5 w-2.5 bg-muted-foreground group-hover:w-4 group-hover:bg-foreground/70 group-focus-visible:w-4 group-focus-visible:bg-foreground/70'
							)}
						></span>
					</button>
				</li>
			{/each}
		</ol>
		{#if hovered}
			<div
				aria-hidden="true"
				class="absolute left-full ml-2 w-max max-w-56 -translate-y-1/2 animate-in rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md fade-in-0 zoom-in-95 motion-reduce:animate-none"
				style:top="{hovered.top}px"
			>
				{#if hoveredPosition > 0}
					<span class="block text-muted-foreground tabular-nums"
						>{hoveredPosition} of {items.length}</span
					>
				{/if}
				<span class="line-clamp-3 break-words">{previewText(hovered.item.text)}</span>
			</div>
		{/if}
	</nav>
{/if}
