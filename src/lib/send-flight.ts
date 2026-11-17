// Sending from an open chat's composer: the typed text, drawn as a message
// bubble, glides from the composer into the message it becomes (or into its row
// in the queue), and the real one fades in under it as it lands.
//
// A single fixed element animated frame by frame, not a View Transition: sends
// are frequent, and a View Transition would snapshot the page and swallow clicks
// while it plays. Frame by frame also follows the target while the timeline
// scrolls to the new message. Skipped with prefers-reduced-motion, like the
// new-chat launch (launch-transition).

export type FlightTarget = 'message' | 'queue';

const DURATION_MS = 460;
/** Uploads can hold the message back; past this the text just lifts away. */
const WAIT_MS = 1500;

/** CSS cubic-bezier() as a function of time. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
	const at = (a: number, b: number, t: number) =>
		3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
	return (x: number) => {
		let lo = 0;
		let hi = 1;
		for (let i = 0; i < 20; i++) {
			const mid = (lo + hi) / 2;
			if (at(x1, x2, mid) < x) lo = mid;
			else hi = mid;
		}
		return at(y1, y2, (lo + hi) / 2);
	};
}

/** Same gentle settle as the launch's message flight (launch.css). */
const ease = cubicBezier(0.3, 1.1, 0.4, 1);

const TARGETS: Record<FlightTarget, string> = {
	// The new user message's bubble, or the message itself when it has no text.
	message: "main [data-message-role='user']",
	queue: 'main [data-queued-message]'
};

function landingSpot(row: Element): HTMLElement {
	return (row.querySelector<HTMLElement>('[data-message-bubble], [data-queued-text]') ??
		row) as HTMLElement;
}

/** Resolves with the first `selector` match that isn't in `before`, or null after `ms`. */
function newMatch(selector: string, before: Set<Element>, ms: number): Promise<Element | null> {
	const find = () => [...document.querySelectorAll(selector)].find((el) => !before.has(el)) ?? null;
	const found = find();
	if (found) return Promise.resolve(found);
	return new Promise((resolve) => {
		const done = (el: Element | null) => {
			observer.disconnect();
			clearTimeout(timer);
			resolve(el);
		};
		const observer = new MutationObserver(() => {
			const el = find();
			if (el) done(el);
		});
		const timer = setTimeout(() => done(null), ms);
		observer.observe(document.body, { childList: true, subtree: true });
	});
}

export type Flight = {
	/** The send went through: fly into the message (or queue row) as it appears. */
	land(): void;
	/** The send failed: the text stays in the composer, so the copy just goes. */
	cancel(): void;
};

const NONE: Flight = { land() {}, cancel() {} };

/**
 * Starts a flight for `text` from `textarea`, before the send clears it. Call
 * `land()` once the send went through, or `cancel()` if it failed.
 */
export function startFlight(
	textarea: HTMLTextAreaElement | null,
	text: string,
	target: FlightTarget
): Flight {
	if (!textarea || !text || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
		return NONE;

	const selector = TARGETS[target];
	const before = new Set(document.querySelectorAll(selector));
	const rect = textarea.getBoundingClientRect();
	const style = getComputedStyle(textarea);

	// Looks like a user bubble (MessageContent), sitting where the text was.
	const ghost = document.createElement('div');
	ghost.className =
		'prose rounded-lg bg-secondary p-2 wrap-break-word whitespace-pre-wrap text-foreground shadow-xs';
	ghost.textContent = text;
	ghost.setAttribute('aria-hidden', 'true');
	const left = rect.left + parseFloat(style.paddingLeft) - 8;
	const top = rect.top + parseFloat(style.paddingTop) - 8;
	Object.assign(ghost.style, {
		position: 'fixed',
		left: '0',
		top: '0',
		zIndex: '50',
		maxWidth: `${Math.min(rect.width, 560)}px`,
		maxHeight: `${Math.max(rect.height, 40) + 16}px`,
		overflow: 'hidden',
		pointerEvents: 'none',
		transformOrigin: '0 0',
		transform: `translate(${left}px, ${top}px)`,
		willChange: 'transform, opacity'
	});
	// The queue shows one truncated line; starting as one keeps the text from reflowing mid-flight.
	if (target === 'queue') {
		Object.assign(ghost.style, { whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
	}
	document.body.append(ghost);

	// The composer's own copy of the text hides while the ghost carries it.
	const { color, webkitTextFillColor } = textarea.style;
	textarea.style.color = 'transparent';
	textarea.style.webkitTextFillColor = 'transparent';
	const restoreText = () => {
		textarea.style.color = color;
		textarea.style.webkitTextFillColor = webkitTextFillColor;
	};

	let settled = false;
	const finish = () => {
		if (settled) return;
		settled = true;
		ghost.remove();
	};

	/** No message to land in: lift a little and fade where it is. */
	const liftAway = () => {
		ghost
			.animate(
				[
					{ transform: `translate(${left}px, ${top}px)`, opacity: 1 },
					{ transform: `translate(${left}px, ${top - 40}px)`, opacity: 0 }
				],
				{ duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
			)
			.finished.then(finish, finish);
	};

	const fly = (row: Element) => {
		const spot = landingSpot(row);
		const spotOpacity = spot.style.opacity;
		spot.style.opacity = '0';
		// One uniform scale, from the font sizes, so the text never stretches: a
		// bubble lands as a bubble (scale ~1), the queue's smaller one-line text
		// shrinks it evenly.
		const ghostStyle = getComputedStyle(ghost);
		const spotStyle = getComputedStyle(spot);
		const ghostFont = parseFloat(ghostStyle.fontSize) || 16;
		const scale = (parseFloat(spotStyle.fontSize) || ghostFont) / ghostFont;
		const pad = parseFloat(ghostStyle.paddingTop) || 0;
		const ghostLine = parseFloat(ghostStyle.lineHeight) || ghostFont * 1.5;
		// A queued row is plain text, not a bubble: the copy sheds its bubble on the way.
		const intoBubble = spot.hasAttribute('data-message-bubble');
		/** Where the copy's top-left goes so its box (bubble) or its text (queue) lines up. */
		const destination = (to: DOMRect) =>
			intoBubble
				? { x: to.left, y: to.top }
				: {
						x: to.left - pad * scale,
						y: to.top + (to.height - ghostLine * scale) / 2 - pad * scale
					};
		const start = performance.now();
		// Typing or clicking meanwhile hurries it along; it never holds anyone up.
		let rate = 1;
		const hurry = () => (rate = 4);
		window.addEventListener('keydown', hurry, { capture: true, once: true });
		window.addEventListener('pointerdown', hurry, { capture: true, once: true });
		let progress = 0;
		let last = start;
		const frame = (now: number) => {
			progress = Math.min(1, progress + ((now - last) * rate) / DURATION_MS);
			last = now;
			// Re-measured every frame: the timeline scrolls the new message into view.
			const to = destination(spot.getBoundingClientRect());
			const k = ease(progress);
			const x = left + (to.x - left) * k;
			const y = top + (to.y - top) * k;
			const s = 1 + (scale - 1) * k;
			ghost.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
			if (!intoBubble) {
				const chrome = Math.round((1 - Math.min(1, progress * 1.6)) * 100);
				ghost.style.backgroundColor = `color-mix(in oklab, var(--secondary) ${chrome}%, transparent)`;
				ghost.style.boxShadow = 'none';
			}
			// Hand over to the real bubble over the last stretch.
			const handoff = Math.max(0, (progress - 0.7) / 0.3);
			ghost.style.opacity = String(1 - handoff);
			spot.style.opacity = String(handoff);
			if (progress < 1) {
				requestAnimationFrame(frame);
				return;
			}
			spot.style.opacity = spotOpacity;
			window.removeEventListener('keydown', hurry, { capture: true });
			window.removeEventListener('pointerdown', hurry, { capture: true });
			finish();
		};
		requestAnimationFrame(frame);
	};

	return {
		land() {
			restoreText();
			void newMatch(selector, before, WAIT_MS).then((row) => (row ? fly(row) : liftAway()));
		},
		cancel() {
			restoreText();
			ghost
				.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' })
				.finished.then(finish, finish);
		}
	};
}
