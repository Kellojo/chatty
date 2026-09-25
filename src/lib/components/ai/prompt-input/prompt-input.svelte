<script lang="ts">
	import { cn } from '$lib/utils';
	import { Tooltip as TooltipPrimitive } from 'bits-ui';
	import {
		PromptInputClass,
		setPromptInputContext,
		type PromptInputSchema
	} from './context.svelte.js';
	import { untrack } from 'svelte';

	let {
		class: className,
		isLoading = false,
		value,
		onValueChange,
		maxHeight = 240,
		onSubmit,
		children
	}: PromptInputSchema & {
		class?: string;
		children: import('svelte').Snippet;
	} = $props();

	const contextInstance = new PromptInputClass({
		isLoading: untrack(() => isLoading),
		value: untrack(() => value),
		onValueChange: untrack(() => onValueChange),
		maxHeight: untrack(() => maxHeight),
		onSubmit: untrack(() => onSubmit),
		disabled: untrack(() => isLoading)
	});

	setPromptInputContext(contextInstance);

	$effect(() => {
		contextInstance.isLoading = isLoading;
		contextInstance.disabled = isLoading;
	});

	$effect(() => {
		contextInstance.onSubmit = onSubmit;
	});

	$effect(() => {
		contextInstance.onValueChange = onValueChange;
	});

	$effect(() => {
		if (value !== undefined) {
			contextInstance.value = value;
		}
	});

	$effect(() => {
		contextInstance.maxHeight = maxHeight;
	});

	function focusTextarea(e?: MouseEvent) {
		if (e) {
			const target = e.target as HTMLElement;
			if (target.closest('button, a, [role="button"], input, select')) return;
		}
		contextInstance.textareaRef?.focus();
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			focusTextarea();
		}
	}
</script>

<TooltipPrimitive.Provider>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class={cn('cursor-text rounded-3xl border border-input bg-background p-2 shadow-xs', className)}
		onclick={focusTextarea}
		role="button"
		tabindex="-1"
	>
		<!-- onkeydown={handleKeyDown} -->
		{@render children()}
	</div>
</TooltipPrimitive.Provider>
