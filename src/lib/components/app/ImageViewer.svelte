<script lang="ts">
	// Full-screen image viewer: zoom (wheel, pinch, double-click/tap, keys), pan
	// (drag while zoomed), rotate and download. Rotation is bindable so a chat
	// thumbnail and its viewer stay turned the same way.
	import { untrack } from 'svelte';
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { fitRotated, normalizeRotation } from '$lib/image-fit.js';
	import { cn } from '$lib/utils.js';
	import XIcon from '@lucide/svelte/icons/x';
	import ZoomInIcon from '@lucide/svelte/icons/zoom-in';
	import ZoomOutIcon from '@lucide/svelte/icons/zoom-out';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LoaderIcon from '@lucide/svelte/icons/loader';

	let {
		open = $bindable(false),
		rotation = $bindable(0),
		src,
		alt = '',
		filename
	}: {
		open?: boolean;
		/** Degrees, any multiple of 90; left unnormalized so turns always animate the short way. */
		rotation?: number;
		src: string;
		alt?: string;
		filename?: string;
	} = $props();

	const MIN_ZOOM = 1;
	const MAX_ZOOM = 8;
	const STEP = 1.5;
	/** Zoom a click or tap on the fitted image jumps to. */
	const TAP_ZOOM = 2.5;
	/** Arrow-key pan step, in screen pixels. */
	const PAN_STEP = 80;
	/** Breathing room between the fitted image and the screen edge. */
	const PAD = 16;

	let stageEl = $state<HTMLDivElement | null>(null);
	let imgEl = $state<HTMLImageElement | null>(null);
	let stageW = $state(0);
	let stageH = $state(0);
	let natural = $state<{ w: number; h: number } | null>(null);
	let failed = $state(false);
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	/** Off while a finger or mouse drives the transform, so it tracks without lag. */
	let gesturing = $state(false);

	const title = $derived(filename || alt || 'Image');
	let contentEl = $state<HTMLElement | null>(null);
	/** The how-to-zoom hint shows briefly, until the first zoom of each opening at most. */
	let hinted = $state(false);
	/** The live region stays quiet until the view is first changed. */
	let touched = $state(false);
	const turns = $derived(normalizeRotation(rotation));
	const fit = $derived(
		natural && stageW && stageH
			? fitRotated(natural.w, natural.h, stageW - PAD * 2, stageH - PAD * 2, rotation)
			: null
	);

	/** Natural size to fitted size. The img keeps its natural size and is scaled by transform,
	 * so a turn (which changes the fit) animates as one smooth transform. */
	const fitScale = $derived(fit && natural ? fit.width / natural.w : 1);

	$effect(() => {
		if (!open || hinted) return;
		const t = setTimeout(() => (hinted = true), 4000);
		return () => clearTimeout(t);
	});

	// A resize (or device turn) changes how far the image may be panned.
	$effect(() => {
		void stageW;
		void stageH;
		untrack(() => setPan(panX, panY));
	});

	// Every opening (or new image) starts fitted and centered.
	$effect(() => {
		void src;
		if (open) {
			resetView();
			hinted = false;
			touched = false;
		}
	});

	$effect(() => {
		void src;
		natural = null;
		failed = false;
	});

	// A cached image can finish loading before its onload handler is attached.
	$effect(() => {
		if (imgEl?.complete && imgEl.naturalWidth > 0 && !natural) readNatural(imgEl);
	});

	// Non-passive so the wheel zooms the image instead of scrolling the page.
	$effect(() => {
		const el = stageEl;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const { x, y } = fromCenter(e.clientX, e.clientY);
			// Line- and page-mode wheels report steps, not pixels.
			const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stageH : 1);
			zoomTo(zoom * Math.exp(-dy * 0.0025), x, y);
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	});

	function readNatural(img: HTMLImageElement) {
		if (img.naturalWidth > 0) natural = { w: img.naturalWidth, h: img.naturalHeight };
	}

	function resetView() {
		touched = true;
		zoom = 1;
		panX = 0;
		panY = 0;
	}

	/** A viewport point relative to the stage center, the origin pan and zoom work in. */
	function fromCenter(clientX: number, clientY: number) {
		const rect = stageEl?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
	}

	/** Keeps the image from being dragged further than its edges reaching the screen's. */
	function clampPan(x: number, y: number, z: number) {
		if (!fit) return { x: 0, y: 0 };
		const maxX = Math.max(0, (fit.boxWidth * z - stageW) / 2 + PAD);
		const maxY = Math.max(0, (fit.boxHeight * z - stageH) / 2 + PAD);
		return {
			x: Math.min(maxX, Math.max(-maxX, x)),
			y: Math.min(maxY, Math.max(-maxY, y))
		};
	}

	function setPan(x: number, y: number, z = zoom) {
		const p = clampPan(x, y, z);
		panX = p.x;
		panY = p.y;
	}

	/** Zooms keeping the image point under (`cx`, `cy`) in place. */
	function zoomTo(target: number, cx = 0, cy = 0) {
		const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
		if (next > 1) hinted = true;
		touched = true;
		const k = next / zoom;
		const x = cx - (cx - panX) * k;
		const y = cy - (cy - panY) * k;
		zoom = next;
		setPan(x, y, next);
	}

	function rotateBy(delta: number) {
		rotation += delta;
		touched = true;
		// Keep the zoom and turn the pan with the image, so the same spot stays in view.
		const [x, y] = delta > 0 ? [-panY, panX] : [panY, -panX];
		setPan(x, y);
	}

	function zoomInAt(clientX: number, clientY: number) {
		const { x, y } = fromCenter(clientX, clientY);
		zoomTo(TAP_ZOOM, x, y);
	}

	// --- Pointer gestures: one pointer pans, two pinch-zoom. ---
	// Gesture bookkeeping only, never rendered: a plain Map on purpose.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const pointers = new Map<number, { x: number; y: number }>();
	let drag: { x: number; y: number; panX: number; panY: number } | null = null;
	let pinch: {
		dist: number;
		zoom: number;
		mid: { x: number; y: number };
		panX: number;
		panY: number;
	} | null = null;
	let moved = false;
	/** Pointer capture retargets later events to the stage, so note where the gesture began. */
	let downOnImage = false;
	let lastTap = 0;

	function startGesture() {
		const pts = [...pointers.values()];
		if (pts.length >= 2) {
			const [a, b] = pts;
			drag = null;
			pinch = {
				dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
				zoom,
				mid: fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2),
				panX,
				panY
			};
		} else if (pts.length === 1) {
			pinch = null;
			drag = { x: pts[0].x, y: pts[0].y, panX, panY };
		} else {
			drag = pinch = null;
		}
	}

	function onPointerDown(e: PointerEvent) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		stageEl?.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) {
			moved = false;
			downOnImage = e.target === imgEl;
		}
		gesturing = true;
		startGesture();
	}

	function onPointerMove(e: PointerEvent) {
		if (!pointers.has(e.pointerId)) return;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pinch) {
			const [a, b] = [...pointers.values()];
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			const mid = fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2);
			const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (pinch.zoom * dist) / pinch.dist));
			const k = z / pinch.zoom;
			zoom = z;
			if (z > 1) hinted = true;
			touched = true;
			setPan(mid.x - (pinch.mid.x - pinch.panX) * k, mid.y - (pinch.mid.y - pinch.panY) * k, z);
			moved = true;
		} else if (drag) {
			const dx = e.clientX - drag.x;
			const dy = e.clientY - drag.y;
			if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
			if (zoom > 1) setPan(drag.panX + dx, drag.panY + dy);
		}
	}

	function onPointerUp(e: PointerEvent) {
		if (!pointers.delete(e.pointerId)) return;
		startGesture();
		if (pointers.size > 0) return;
		gesturing = false;
		if (moved || e.type === 'pointercancel') return;
		// A tap on the backdrop closes. On the image, a tap at fit zooms in there;
		// once zoomed, single taps are left to panning and a double tap fits again.
		if (!downOnImage) {
			open = false;
			return;
		}
		if (zoom <= 1) {
			lastTap = 0;
			zoomInAt(e.clientX, e.clientY);
		} else if (e.timeStamp - lastTap < 300) {
			lastTap = 0;
			resetView();
		} else {
			lastTap = e.timeStamp;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const handled = (() => {
			switch (e.key) {
				case '+':
				case '=':
					zoomTo(zoom * STEP);
					return true;
				case '-':
				case '_':
					zoomTo(zoom / STEP);
					return true;
				case '0':
					resetView();
					return true;
				case 'r':
				case 'R':
					// By physical key, so Caps Lock doesn't swap the directions.
					rotateBy(e.shiftKey ? -90 : 90);
					return true;
				// Arrows look around a zoomed image; at fit they keep their usual meaning.
				case 'ArrowLeft':
				case 'ArrowRight':
				case 'ArrowUp':
				case 'ArrowDown': {
					if (zoom <= 1) return false;
					const dx = e.key === 'ArrowLeft' ? PAN_STEP : e.key === 'ArrowRight' ? -PAN_STEP : 0;
					const dy = e.key === 'ArrowUp' ? PAN_STEP : e.key === 'ArrowDown' ? -PAN_STEP : 0;
					setPan(panX + dx, panY + dy);
					return true;
				}
				default:
					return false;
			}
		})();
		if (handled) e.preventDefault();
	}

	const btn =
		'flex size-11 shrink-0 sm:size-9 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40';
</script>

<DialogPrimitive.Root bind:open>
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay
			class="fixed inset-0 z-50 bg-black/95 duration-150 motion-reduce:animate-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
		/>
		<DialogPrimitive.Content
			class="fixed inset-0 z-50 flex flex-col text-white duration-150 outline-none motion-reduce:animate-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
			bind:ref={contentEl}
			onkeydown={onKeydown}
			onOpenAutoFocus={(e) => {
				e.preventDefault();
				// The dialog itself, so shortcuts work at once without a ring on a button.
				contentEl?.focus();
			}}
		>
			<div
				class="flex items-center gap-0.5 bg-gradient-to-b from-black/60 to-transparent px-3 pt-[max(0.5rem,var(--safe-top))] pb-2"
			>
				<div class="flex min-w-0 flex-1 items-baseline gap-2 px-1">
					<DialogPrimitive.Title
						class={cn('min-w-0 truncate text-sm font-medium', zoom > 1 && 'max-sm:sr-only')}
						>{title}</DialogPrimitive.Title
					>
					{#if natural}
						<span class="hidden shrink-0 text-xs text-white/60 tabular-nums sm:inline"
							>{turns % 180 ? `${natural.h} × ${natural.w}` : `${natural.w} × ${natural.h}`}</span
						>
					{/if}
				</div>
				<button
					type="button"
					class={cn(btn, 'hidden sm:flex')}
					title="Zoom out (-)"
					aria-label="Zoom out"
					disabled={zoom <= MIN_ZOOM}
					onclick={() => zoomTo(zoom / STEP)}
				>
					<ZoomOutIcon class="size-4.5" />
				</button>
				<!-- On touch screens zoom is pinch or tap, so the level only shows (as a way back) once zoomed. -->
				<button
					type="button"
					class={cn(
						'h-11 min-w-14 shrink-0 rounded-full px-2 text-xs text-white/90 tabular-nums transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none sm:h-9',
						zoom > 1 ? 'bg-white/10 sm:bg-transparent' : 'hidden sm:block'
					)}
					title="Fit to screen (0)"
					aria-label={zoom > 1
						? `Zoom ${Math.round(zoom * 100)}%, fit to screen`
						: 'Fitted to screen'}
					onclick={resetView}
				>
					{zoom > 1 ? `${Math.round(zoom * 100)}%` : 'Fit'}
				</button>
				<button
					type="button"
					class={cn(btn, 'hidden sm:flex')}
					title="Zoom in (+)"
					aria-label="Zoom in"
					disabled={zoom >= MAX_ZOOM}
					onclick={() => zoomTo(zoom * STEP)}
				>
					<ZoomInIcon class="size-4.5" />
				</button>
				<span class="mx-1 hidden h-5 w-px bg-white/20 sm:block" aria-hidden="true"></span>
				<button
					type="button"
					class={btn}
					title="Rotate left (Shift+R)"
					aria-label="Rotate left"
					onclick={() => rotateBy(-90)}
				>
					<RotateCcwIcon class="size-4.5" />
				</button>
				<button
					type="button"
					class={btn}
					title="Rotate right (R)"
					aria-label="Rotate right"
					onclick={() => rotateBy(90)}
				>
					<RotateCwIcon class="size-4.5" />
				</button>
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href={src}
					download={filename ?? ''}
					class={btn}
					title="Download"
					aria-label="Download image"
				>
					<DownloadIcon class="size-4.5" />
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
				<DialogPrimitive.Close class={btn} title="Close (Esc)" aria-label="Close">
					<XIcon class="size-5" />
				</DialogPrimitive.Close>
			</div>

			<DialogPrimitive.Description class="sr-only">
				{alt && alt !== title ? `${alt}. ` : ''}Plus and minus zoom, R rotates, arrow keys pan when
				zoomed, Escape closes.
			</DialogPrimitive.Description>
			<p class="sr-only" aria-live="polite">
				{#if touched}
					{zoom > 1 ? `Zoom ${Math.round(zoom * 100)}%` : 'Fitted to screen'}{turns
						? `, rotated ${turns} degrees`
						: ''}
				{/if}
			</p>
			<div
				bind:this={stageEl}
				bind:clientWidth={stageW}
				bind:clientHeight={stageH}
				class="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
				role="presentation"
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerUp}
			>
				{#if failed}
					<p class="absolute inset-0 grid place-items-center text-sm text-white/70">
						Image not available
					</p>
				{:else}
					{#if !fit}
						<LoaderIcon
							class="absolute top-1/2 left-1/2 size-6 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/70"
						/>
					{/if}
					<img
						bind:this={imgEl}
						{src}
						{alt}
						draggable="false"
						onload={(e) => readNatural(e.currentTarget as HTMLImageElement)}
						onerror={() => (failed = true)}
						class={cn(
							'absolute top-1/2 left-1/2 max-w-none',
							!fit && 'opacity-0',
							!gesturing &&
								'transition-transform duration-200 ease-out motion-reduce:transition-none',
							zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
						)}
						style:width={natural ? `${natural.w}px` : undefined}
						style:height={natural ? `${natural.h}px` : undefined}
						style:transform={`translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${fitScale * zoom}) rotate(${rotation}deg)`}
					/>
					{#if fit && !hinted}
						<p
							class="pointer-events-none absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-xs whitespace-nowrap text-white/80 backdrop-blur-sm"
							aria-hidden="true"
						>
							<span class="[@media(hover:none)]:hidden">Click or scroll to zoom</span>
							<span class="hidden [@media(hover:none)]:inline">Tap or pinch to zoom</span>
						</p>
					{/if}
				{/if}
			</div>
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
</DialogPrimitive.Root>
