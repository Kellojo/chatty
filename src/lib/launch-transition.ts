// The start screen → new chat "launch": a View Transition that glides the
// composer down into the chat, flies the typed text up into the first message
// bubble, and brings the chat in with one of a few quiet page moves
// (src/routes/launch.css).
//
// The same move every time gets old, so each launch picks one it hasn't shown
// recently (least recently used wins, with a little randomness), with a random
// direction. Frequent launches get progressively quicker so it never stands in
// the way of a heavy user. Skipped entirely with prefers-reduced-motion.

import { tick } from 'svelte';

export type LaunchKind = 'chat' | 'coding';

export type LaunchVariant = 'rise' | 'drift' | 'focus' | 'sweep' | 'unfold' | 'print';

const VARIANTS: Record<LaunchKind, LaunchVariant[]> = {
	chat: ['rise', 'drift', 'focus', 'sweep', 'unfold'],
	coding: ['print', 'drift', 'focus', 'sweep']
};

const HISTORY_KEY = 'chatty:launch-history';
/** Launches within this window count towards the "frequent user" damping. */
const STREAK_WINDOW_MS = 10 * 60_000;

export type LaunchPlan = {
	variant: LaunchVariant;
	/** Direction for drift and sweep (1 = towards the right / down, -1 = the other way). */
	dir: 1 | -1;
	/** Sweep runs top to bottom instead of across. */
	vertical: boolean;
	/** Duration factor: below 1 when launching often. */
	speed: number;
};

type History = { order: LaunchVariant[]; times: number[] };

function readHistory(): History {
	try {
		const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '') as Partial<History>;
		if (Array.isArray(parsed.order)) {
			return { order: parsed.order, times: Array.isArray(parsed.times) ? parsed.times : [] };
		}
	} catch {
		// Missing or unreadable: start fresh.
	}
	return { order: [], times: [] };
}

function writeHistory(history: History) {
	try {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
	} catch {
		// Private mode or blocked storage: variety just isn't remembered.
	}
}

/**
 * Least recently used variant for this kind, picked at random among the two
 * stalest so the order never settles into a fixed cycle. Never the last one.
 */
export function pickVariant(
	kind: LaunchKind,
	order: readonly LaunchVariant[],
	random = Math.random
): LaunchVariant {
	const pool = VARIANTS[kind];
	// The very first launch shows the signature move for its kind.
	if (order.length === 0) return pool[0];
	const age = (v: LaunchVariant) => {
		const i = order.indexOf(v);
		return i === -1 ? Infinity : i;
	};
	const ranked = [...pool].sort((a, b) => age(b) - age(a));
	const candidates = ranked.slice(0, 2).filter((v) => v !== order[0]);
	return candidates[Math.floor(random() * candidates.length)] ?? ranked[0];
}

/** Duration factor for the nth launch in a short window: full length for the first two, then quicker. */
export function damping(recentLaunches: number): number {
	return Math.max(0.5, 1 - Math.max(0, recentLaunches - 2) * 0.1);
}

type Armed = LaunchPlan & { text: string };

class LaunchState {
	#armed: Armed | null = null;

	/** Called on submit: the next navigation into a chat plays the launch. */
	arm(kind: LaunchKind, text: string, random = Math.random) {
		const history = readHistory();
		const variant = pickVariant(kind, history.order, random);
		const now = Date.now();
		const times = [now, ...history.times.filter((t) => now - t < STREAK_WINDOW_MS)].slice(0, 20);
		writeHistory({ order: [variant, ...history.order.filter((v) => v !== variant)], times });
		this.#armed = {
			variant,
			dir: random() < 0.5 ? 1 : -1,
			vertical: random() < 0.4,
			speed: damping(times.length),
			text
		};
	}

	disarm() {
		this.#armed = null;
	}

	take(): Armed | null {
		const armed = this.#armed;
		this.#armed = null;
		return armed;
	}
}

export const launch = new LaunchState();

/**
 * Resolves once `selector` matches, or after `ms` regardless. The chat adds the
 * first message only after its attachments are uploaded, which can land just
 * after navigation; waiting a moment keeps the "after" snapshot complete.
 */
function appeared(selector: string, ms: number): Promise<void> {
	if (document.querySelector(selector)) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			observer.disconnect();
			clearTimeout(timer);
			resolve();
		};
		const observer = new MutationObserver(() => {
			if (document.querySelector(selector)) done();
		});
		const timer = setTimeout(done, ms);
		observer.observe(document.body, { childList: true, subtree: true });
	});
}

function prefersReducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The typed text as a message bubble, laid over the start screen's textarea so
 * it is part of the "before" snapshot. It carries `launch-message`, as does the
 * chat's first bubble, so the browser flies one into the other. The textarea's
 * own text is hidden meanwhile so the composer travels down empty.
 */
function liftMessage(text: string): () => void {
	const textarea = document.querySelector<HTMLTextAreaElement>('main .launch-composer textarea');
	if (!textarea || !text) return () => {};
	const rect = textarea.getBoundingClientRect();
	const style = getComputedStyle(textarea);
	const ghost = document.createElement('div');
	// Same look as a user bubble (MessageContent), starting where the text was.
	ghost.className =
		'launch-message-ghost prose rounded-lg bg-secondary p-2 wrap-break-word whitespace-pre-wrap text-foreground';
	ghost.textContent = text;
	ghost.setAttribute('aria-hidden', 'true');
	Object.assign(ghost.style, {
		position: 'fixed',
		left: `${rect.left + parseFloat(style.paddingLeft) - 8}px`,
		top: `${rect.top + parseFloat(style.paddingTop) - 8}px`,
		maxWidth: `${rect.width}px`,
		maxHeight: `${Math.max(rect.height, 40) + 16}px`,
		overflow: 'hidden',
		pointerEvents: 'none'
	});
	document.body.append(ghost);
	const { color, webkitTextFillColor } = textarea.style;
	textarea.style.color = 'transparent';
	textarea.style.webkitTextFillColor = 'transparent';
	return () => {
		ghost.remove();
		textarea.style.color = color;
		textarea.style.webkitTextFillColor = webkitTextFillColor;
	};
}

/**
 * Runs the launch as a View Transition around a SvelteKit navigation
 * (`onNavigate`). Returns a promise to hand back from the callback, or
 * undefined when nothing was armed or it can't play.
 */
export function launchTransition(complete: Promise<void>): Promise<void> | undefined {
	const armed = launch.take();
	if (!armed || !document.startViewTransition || prefersReducedMotion()) return;
	const root = document.documentElement;
	root.style.setProperty('--launch-speed', String(armed.speed));
	root.dataset.launch = armed.variant;
	root.dataset.launchDir = armed.dir === 1 ? 'fwd' : 'back';
	root.dataset.launchAxis = armed.vertical ? 'v' : 'h';

	const cleanup = () => {
		delete root.dataset.launch;
		delete root.dataset.launchDir;
		delete root.dataset.launchAxis;
		root.style.removeProperty('--launch-speed');
	};

	const unlift = liftMessage(armed.text);
	return new Promise((resolve) => {
		const transition = document.startViewTransition!(async () => {
			unlift();
			resolve();
			await complete;
			// Lets the chat render its first message, so the bubble is in the "after" snapshot.
			await tick();
			// With attachments it only shows once they're uploaded; worth a short wait, not a long one.
			await appeared("main [data-message-role='user']", 400);
		});
		// Skipped (e.g. the tab was hidden): put the text back right away.
		transition.ready.catch(unlift);
		// Typing or clicking while it plays fast-forwards it: it never holds anyone up.
		const hurry = () => {
			for (const animation of document.getAnimations()) {
				const pseudo = (animation.effect as KeyframeEffect | null)?.pseudoElement;
				// The snapshots, and the composer / reply easing in underneath them.
				const name = animation instanceof CSSAnimation ? animation.animationName : '';
				if (pseudo?.startsWith('::view-transition') || name.startsWith('launch-'))
					animation.playbackRate = 4;
			}
		};
		const options = { capture: true, once: true } as const;
		window.addEventListener('keydown', hurry, options);
		window.addEventListener('pointerdown', hurry, options);
		transition.finished.finally(() => {
			window.removeEventListener('keydown', hurry, options);
			window.removeEventListener('pointerdown', hurry, options);
			cleanup();
		});
	});
}
