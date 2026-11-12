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

	function focusTextarea() {
		contextInstance.textareaRef?.focus();
	}

	// Handled on mousedown (not click) so a press on the padding around the
	// textarea can be cancelled: otherwise the browser starts a text selection
	// there, and a double-click or drag highlights the textarea's placeholder.
	function handleMouseDown(e: MouseEvent) {
		if (e.button !== 0) return;
		const target = e.target as HTMLElement;
		if (target === contextInstance.textareaRef) return;
		if (target.closest('button, a, input, select, textarea, [contenteditable]')) return;
		e.preventDefault();
		focusTextarea();
	}
</script>

<TooltipPrimitive.Provider>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class={cn('cursor-text rounded-3xl border border-input bg-background p-2 shadow-xs', className)}
		onmousedown={handleMouseDown}
	>
		{@render children()}
	</div>
</TooltipPrimitive.Provider>
