<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { cn } from '$lib/utils.js';
	import type { AgentRunStatus } from '$lib/types.js';

	let {
		status,
		label = false,
		class: className
	}: {
		status: AgentRunStatus;
		/** Show the status word next to the icon (a pill), instead of an icon tile. */
		label?: boolean;
		class?: string;
	} = $props();

	const text = $derived(
		status === 'running' ? 'Running' : status === 'success' ? 'Succeeded' : 'Failed'
	);
	const tone = $derived(
		status === 'running'
			? 'bg-info/15 text-info-foreground'
			: status === 'success'
				? 'bg-success/15 text-success-foreground'
				: 'bg-destructive/10 text-destructive'
	);
</script>

{#snippet icon(size: string)}
	{#if status === 'running'}
		<LoaderCircleIcon class="{size} animate-spin" aria-hidden="true" />
	{:else if status === 'success'}
		<CircleCheckIcon class={size} aria-hidden="true" />
	{:else}
		<CircleXIcon class={size} aria-hidden="true" />
	{/if}
{/snippet}

{#if label}
	<span
		class={cn(
			'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
			tone,
			className
		)}
	>
		{@render icon('size-3.5')}
		{text}
	</span>
{:else}
	<span
		class={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', tone, className)}
		title={text}
	>
		{@render icon('size-4')}
		<span class="sr-only">{text}</span>
	</span>
{/if}
