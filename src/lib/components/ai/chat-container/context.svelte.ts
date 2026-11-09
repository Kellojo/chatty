import { createContext } from 'svelte';
import { StickToBottom } from 'stick-to-bottom-svelte';

const DEFAULT_SPRING = {
	damping: 0.7,
	stiffness: 0.05,
	mass: 1.25
} as const;

const SPRING_PRESETS = {
	smooth: DEFAULT_SPRING,
	'ease-out': {
		damping: 0.82,
		stiffness: 0.045,
		mass: 1.2
	}
} as const;

type ChatContainerAnimationPreset = 'instant' | keyof typeof SPRING_PRESETS;
type ChatContainerSpringAnimation = {
	damping?: number;
	stiffness?: number;
	mass?: number;
};
type ChatContainerAnimation = ChatContainerAnimationPreset | ChatContainerSpringAnimation;
type ChatContainerInitialAnimation = ChatContainerAnimation | false;
type ResolvedAnimation = 'instant' | Required<ChatContainerSpringAnimation>;
type ChatContainerScrollToBottomOptions =
	| 'instant'
	| {
			animation?: ChatContainerAnimation;
			wait?: boolean | number;
			ignoreEscapes?: boolean;
			preserveScrollPosition?: boolean;
			duration?: number | Promise<void>;
	  };

type MutableStickToBottomOptions = {
	scrollElement: () => HTMLElement | null;
	contentElement: () => HTMLElement | null;
	resize: ResolvedAnimation;
	initial: ResolvedAnimation | false;
};

function normalizeAnimation(animation: ChatContainerAnimation): ResolvedAnimation {
	if (animation === 'instant') {
		return 'instant';
	}

	if (typeof animation === 'string') {
		return { ...SPRING_PRESETS[animation] };
	}

	return {
		...DEFAULT_SPRING,
		...animation
	};
}

function normalizeInitialAnimation(
	animation: ChatContainerInitialAnimation
): ResolvedAnimation | false {
	if (animation === false) {
		return false;
	}

	return normalizeAnimation(animation);
}

/** How long after a touch/key/wheel gesture an upward scroll counts as the user's. */
const GESTURE_WINDOW_MS = 300;

/**
 * Whether an upward wheel over `target` scrolls `container`, rather than a
 * nested scroller (code block, tool output) that can still scroll up itself.
 */
function scrollsContainer(target: EventTarget | null, container: HTMLElement): boolean {
	for (let node = target instanceof Element ? target : null; node && node !== container; ) {
		if (node.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return false;
		node = node.parentElement;
	}
	return container.scrollTop > 0;
}

class ChatContainerContext {
	#scrollElement: HTMLElement | null = $state(null);
	#contentElement: HTMLElement | null = $state(null);
	#options: MutableStickToBottomOptions;
	#stickToBottom: StickToBottom;

	constructor(
		resize: ChatContainerAnimation = 'smooth',
		initial: ChatContainerInitialAnimation = 'instant'
	) {
		this.#options = {
			scrollElement: () => this.#scrollElement,
			contentElement: () => this.#contentElement,
			resize: normalizeAnimation(resize),
			initial: normalizeInitialAnimation(initial)
		};

		this.#stickToBottom = new StickToBottom(this.#options);

		$effect(() => {
			const el = this.#scrollElement;
			if (el) return this.#watchUserEscape(el);
		});
	}

	/**
	 * Unlock from the bottom as soon as the user scrolls up. The library only
	 * honours wheel events targeting the scroll element itself (not the messages
	 * under the cursor) and ignores scroll events while its follow animation runs,
	 * so during streaming it kept yanking the view back down.
	 */
	#watchUserEscape(el: HTMLElement) {
		let lastTop = el.scrollTop;
		let gestureAt = -Infinity;
		let pointerHeld = false;
		const gesture = () => (gestureAt = performance.now());

		const onWheel = (e: WheelEvent) => {
			gesture();
			if (e.deltaY < 0 && scrollsContainer(e.target, el)) this.stopScroll();
		};
		// Scrollbar drags: pointerdown on the scroll element itself, not its content.
		const onPointerDown = (e: PointerEvent) => {
			if (e.target === el) pointerHeld = true;
		};
		const onPointerUp = () => (pointerHeld = false);
		const onScroll = () => {
			const top = el.scrollTop;
			const userDriven = pointerHeld || performance.now() - gestureAt < GESTURE_WINDOW_MS;
			if (top < lastTop - 1 && userDriven) this.stopScroll();
			lastTop = top;
		};

		const passive = { passive: true } as const;
		el.addEventListener('wheel', onWheel, passive);
		el.addEventListener('touchmove', gesture, passive);
		el.addEventListener('keydown', gesture);
		el.addEventListener('pointerdown', onPointerDown, passive);
		el.addEventListener('scroll', onScroll, passive);
		window.addEventListener('pointerup', onPointerUp, passive);
		window.addEventListener('pointercancel', onPointerUp, passive);
		return () => {
			el.removeEventListener('wheel', onWheel);
			el.removeEventListener('touchmove', gesture);
			el.removeEventListener('keydown', gesture);
			el.removeEventListener('pointerdown', onPointerDown);
			el.removeEventListener('scroll', onScroll);
			window.removeEventListener('pointerup', onPointerUp);
			window.removeEventListener('pointercancel', onPointerUp);
		};
	}

	get isAtBottom() {
		return this.#stickToBottom.isAtBottom;
	}

	get isNearBottom() {
		return this.#stickToBottom.isNearBottom;
	}

	get scrollTop() {
		return this.#stickToBottom.scrollTop;
	}

	get targetScrollTop() {
		return this.#stickToBottom.targetScrollTop;
	}

	setScrollElement(element: HTMLElement | null) {
		this.#scrollElement = element;
	}

	setContentElement(element: HTMLElement | null) {
		this.#contentElement = element;
	}

	updateResize(animation: ChatContainerAnimation) {
		this.#options.resize = normalizeAnimation(animation);
	}

	updateInitial(animation: ChatContainerInitialAnimation) {
		this.#options.initial = normalizeInitialAnimation(animation);
	}

	scrollToBottom = (options?: ChatContainerScrollToBottomOptions) => {
		if (options === undefined) {
			return this.#stickToBottom.scrollToBottom({
				animation: this.#options.resize
			});
		}

		if (options === 'instant') {
			return this.#stickToBottom.scrollToBottom('instant');
		}

		return this.#stickToBottom.scrollToBottom({
			...options,
			animation: options.animation ? normalizeAnimation(options.animation) : undefined
		});
	};

	stopScroll = () => {
		this.#stickToBottom.stopScroll();
	};
}

const [getChatContainerContext, setInternalChatContainerContext] =
	createContext<ChatContainerContext>();

function setChatContainerContext(
	resize: ChatContainerAnimation = 'smooth',
	initial: ChatContainerInitialAnimation = 'instant'
): ChatContainerContext {
	const context = new ChatContainerContext(resize, initial);
	setInternalChatContainerContext(context);
	return context;
}

export { ChatContainerContext, getChatContainerContext, setChatContainerContext };
export type {
	ChatContainerAnimation,
	ChatContainerAnimationPreset,
	ChatContainerInitialAnimation,
	ChatContainerScrollToBottomOptions,
	ChatContainerSpringAnimation
};
