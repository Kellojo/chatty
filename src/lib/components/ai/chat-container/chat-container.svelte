<script lang="ts">
	import { watch } from 'runed';
	import { cn } from '$lib/utils';
	import {
		setChatContainerContext,
		type ChatContainerAnimation,
		type ChatContainerContext,
		type ChatContainerInitialAnimation
	} from './context.svelte.js';

	let {
		ref = $bindable<HTMLDivElement | null>(null),
		context = $bindable<ChatContainerContext | undefined>(),
		children,
		class: className,
		resize = 'smooth',
		initial = 'instant',
		...restProps
	}: {
		ref?: HTMLDivElement | null;
		/** Scroll state and controls, for UI rendered outside the container. */
		context?: ChatContainerContext;
		children?: import('svelte').Snippet;
		class?: string;
		resize?: ChatContainerAnimation;
		initial?: ChatContainerInitialAnimation;
		[key: string]: any;
	} = $props();

	const chatContext = setChatContainerContext();
	context = chatContext;

	// The server renders the log scrolled to the top; keep it hidden until it has
	// been moved to the bottom, so a reload doesn't flash the start of the chat.
	let positioned = $state(false);

	function bindScrollElement(node: HTMLDivElement) {
		ref = node;
		chatContext.setScrollElement(node);
		if (initial !== false) node.scrollTop = node.scrollHeight;
		positioned = true;

		return () => {
			ref = null;
			chatContext.setScrollElement(null);
		};
	}

	watch(
		() => resize,
		() => {
			chatContext.updateResize(resize);
		}
	);

	watch(
		() => initial,
		() => {
			chatContext.updateInitial(initial);
		}
	);
</script>

<div
	{@attach bindScrollElement}
	class={cn(
		// Phones get a longer top fade: their header's two-line title sits right above it.
		!positioned && 'invisible',
		'flex overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_2rem,black_calc(100%-2rem),transparent)] max-sm:[mask-image:linear-gradient(to_bottom,transparent,transparent_0.375rem,black_2.75rem,black_calc(100%-2rem),transparent)]',
		className
	)}
	role="log"
	{...restProps}
>
	{@render children?.()}
</div>
