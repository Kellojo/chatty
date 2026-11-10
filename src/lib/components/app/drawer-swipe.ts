/**
 * iOS-style interactive swipe for the phone sidebar drawer: the drawer follows the
 * finger 1:1, and on release it settles open or closed from where it is, keeping the
 * finger's speed. Reversing direction before letting go cancels, as on iOS.
 */

/** Movement (px) before deciding whether a touch is a horizontal drawer swipe. */
const SLOP = 10;
/** Release speed (px/ms) that commits in its direction, whatever the distance. */
const FLING = 0.3;
/** Only the last stretch of movement counts toward the release speed. */
const VELOCITY_WINDOW_MS = 80;
/** The settle easing's start slope: it leaves at this many times its average speed. */
const EASE_START_SLOPE = 3.2;
export const SETTLE_EASING = 'cubic-bezier(0.25, 0.8, 0.25, 1)';

export interface Release {
	open: boolean;
	durationMs: number;
}

/**
 * Where a released drag goes and how long it takes to get there. `offset` is how far
 * open the drawer is (0..width), `velocity` the finger's speed in px/ms (+ = opening).
 */
export function settle(offset: number, velocity: number, width: number): Release {
	const open = Math.abs(velocity) >= FLING ? velocity > 0 : offset > width / 2;
	const remaining = open ? width - offset : offset;
	const towards = open ? velocity : -velocity;
	const durationMs =
		towards > 0
			? // Flung toward the target: leave at the finger's speed instead of jumping or lagging.
				(EASE_START_SLOPE * remaining) / towards
			: // Released still: proportional to the distance left, like the tap animation.
				(remaining / width) * 350;
	return { open, durationMs: Math.round(Math.min(380, Math.max(160, durationMs))) };
}

export interface DrawerSwipeOptions {
	isOpen(): boolean;
	/** The drawer's travel in px (the viewport width for a full-screen drawer). */
	width(): number;
	/** Whether a touch starting on `target` may move the drawer. */
	canStart(target: Element, open: boolean): boolean;
	/** The drawer is being dragged: `offset` px open, 0..width. */
	ondrag(offset: number): void;
	/** The finger lifted (or the touch was cancelled): animate to `open`. */
	onrelease(release: Release): void;
}

/** An element between `target` and `root` that would scroll sideways under this swipe. */
function scrollsSideways(target: Element, root: Element, dx: number): boolean {
	for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
		if (el.scrollWidth <= el.clientWidth + 1) continue;
		const overflow = getComputedStyle(el).overflowX;
		if (overflow !== 'auto' && overflow !== 'scroll') continue;
		// Swiping right reveals content to the left, so it scrolls if not at the start.
		if (dx > 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
			return true;
	}
	return false;
}

export function drawerSwipe(root: HTMLElement, options: DrawerSwipeOptions): () => void {
	type Gesture = {
		id: number;
		target: Element;
		startX: number;
		startY: number;
		open: boolean;
		/** Set once the touch is known to be a drawer swipe. */
		origin: number | null;
		width: number;
		offset: number;
		samples: { x: number; t: number }[];
	};
	let gesture: Gesture | null = null;

	function onStart(event: TouchEvent) {
		if (event.touches.length !== 1) {
			// A second finger (pinch) ends a swipe in progress where it stands.
			if (gesture && gesture.origin !== null) finish(0);
			gesture = null;
			return;
		}
		const touch = event.touches[0];
		const target = event.target;
		if (!(target instanceof Element)) return;
		const open = options.isOpen();
		// Leave text selection handles alone.
		if (!document.getSelection()?.isCollapsed) return;
		if (!options.canStart(target, open)) return;
		gesture = {
			id: touch.identifier,
			target,
			startX: touch.clientX,
			startY: touch.clientY,
			open,
			origin: null,
			width: options.width(),
			offset: open ? options.width() : 0,
			samples: []
		};
	}

	function onMove(event: TouchEvent) {
		if (!gesture) return;
		const touch = [...event.changedTouches].find((t) => t.identifier === gesture!.id);
		if (!touch) return;
		const x = touch.clientX;
		if (gesture.origin === null) {
			const dx = x - gesture.startX;
			const dy = touch.clientY - gesture.startY;
			if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
			// Mostly sideways, in the direction the drawer can go, and nothing else scrolls.
			const sideways = Math.abs(dx) > Math.abs(dy) * 1.2;
			const towardsOther = gesture.open ? dx < 0 : dx > 0;
			if (!sideways || !towardsOther || scrollsSideways(gesture.target, root, dx)) {
				gesture = null;
				return;
			}
			// Track from here, so the drawer doesn't jump by the slop.
			gesture.origin = x;
		}
		if (event.cancelable) event.preventDefault();
		const start = gesture.open ? gesture.width : 0;
		gesture.offset = Math.min(gesture.width, Math.max(0, start + x - gesture.origin));
		const t = event.timeStamp;
		gesture.samples.push({ x, t });
		while (gesture.samples.length > 2 && t - gesture.samples[0].t > VELOCITY_WINDOW_MS)
			gesture.samples.shift();
		options.ondrag(gesture.offset);
	}

	function velocity(now: number): number {
		const samples = gesture?.samples ?? [];
		if (samples.length < 2) return 0;
		const first = samples[0];
		const last = samples[samples.length - 1];
		// A finger that stopped before lifting has no speed left.
		if (now - last.t > VELOCITY_WINDOW_MS) return 0;
		const dt = last.t - first.t;
		return dt > 0 ? (last.x - first.x) / dt : 0;
	}

	function finish(v: number) {
		if (!gesture || gesture.origin === null) return;
		const release = settle(gesture.offset, v, gesture.width);
		gesture = null;
		options.onrelease(release);
	}

	function onEnd(event: TouchEvent) {
		if (!gesture) return;
		if (![...event.changedTouches].some((t) => t.identifier === gesture!.id)) return;
		if (gesture.origin === null) {
			gesture = null;
			return;
		}
		finish(velocity(event.timeStamp));
	}

	function onCancel(event: TouchEvent) {
		if (!gesture) return;
		if (![...event.changedTouches].some((t) => t.identifier === gesture!.id)) return;
		if (gesture.origin === null) {
			gesture = null;
			return;
		}
		// The system took the touch: go back to where the swipe started.
		const { open, width, offset } = gesture;
		gesture = null;
		const remaining = open ? width - offset : offset;
		options.onrelease({ open, durationMs: Math.round(Math.max(160, (remaining / width) * 350)) });
	}

	// touchmove can't be passive: an engaged swipe stops the page scrolling vertically.
	root.addEventListener('touchstart', onStart, { passive: true });
	root.addEventListener('touchmove', onMove, { passive: false });
	root.addEventListener('touchend', onEnd, { passive: true });
	root.addEventListener('touchcancel', onCancel, { passive: true });
	return () => {
		root.removeEventListener('touchstart', onStart);
		root.removeEventListener('touchmove', onMove);
		root.removeEventListener('touchend', onEnd);
		root.removeEventListener('touchcancel', onCancel);
	};
}
