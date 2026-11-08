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

	function bindScrollElement(node: HTMLDivElement) {
		ref = node;
		chatContext.setScrollElement(node);

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
		'flex overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_2rem,black_calc(100%-2rem),transparent)]',
		className
	)}
	role="log"
	{...restProps}
>
	{@render children?.()}
</div>
