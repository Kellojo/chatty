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

	function handleClick() {
		contextInstance.textareaRef?.focus();
	}

	function handleKeyDown(e: KeyboardEvent) {
		// Only handle Enter key to focus textarea from wrapper
		// Don't intercept Space key as it prevents typing spaces in the textarea
		if (e.key === 'Enter') {
			e.preventDefault();
			handleClick();
		}
	}
</script>

<TooltipPrimitive.Provider>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class={cn('cursor-text rounded-3xl border border-input bg-background p-2 shadow-xs', className)}
		onclick={handleClick}
		role="button"
		tabindex="-1"
	>
		<!-- onkeydown={handleKeyDown} -->
		{@render children()}
	</div>
</TooltipPrimitive.Provider>
