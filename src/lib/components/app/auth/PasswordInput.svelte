<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import { Input } from '$lib/components/ui/input/index.js';

	let {
		value = $bindable(''),
		ref = $bindable(null),
		...rest
	}: Omit<HTMLInputAttributes, 'type' | 'files'> & { ref?: HTMLInputElement | null } = $props();

	let visible = $state(false);
	const toggleHint = $derived(visible ? 'Hide password' : 'Show password');
</script>

<div class="relative">
	<Input
		type={visible ? 'text' : 'password'}
		bind:value
		bind:ref
		class="pr-11 pointer-coarse:pr-12"
		{...rest}
	/>
	<button
		type="button"
		class="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,box-shadow] outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:right-0.5 pointer-coarse:size-9"
		aria-label="Show password"
		aria-pressed={visible}
		title={toggleHint}
		aria-controls={rest.id}
		onclick={() => (visible = !visible)}
	>
		{#if visible}
			<EyeOffIcon class="size-4" aria-hidden="true" />
		{:else}
			<EyeIcon class="size-4" aria-hidden="true" />
		{/if}
	</button>
</div>
