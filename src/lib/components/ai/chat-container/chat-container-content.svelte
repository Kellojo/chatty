<script lang="ts">
	import { cn } from '$lib/utils';
	import { getChatContainerContext } from './context.svelte.js';

	let {
		children,
		class: className,
		...restProps
	}: {
		children?: import('svelte').Snippet;
		class?: string;
		[key: string]: any;
	} = $props();

	const context = getChatContainerContext();

	function bindContentElement(node: HTMLDivElement) {
		context.setContentElement(node);

		return () => {
			context.setContentElement(null);
		};
	}
</script>

<!-- self-start: stretched to the scroller's height, the box would never grow with the
     messages, and the stick-to-bottom ResizeObserver on it would never fire. -->
<div
	{@attach bindContentElement}
	class={cn('flex w-full flex-col self-start', className)}
	{...restProps}
>
	{@render children?.()}
</div>
