<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleMinusIcon from '@lucide/svelte/icons/circle-minus';
	import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { cn } from '$lib/utils.js';
	import type { AgentRunStatus } from '$lib/types.js';

	let {
		status,
		label = false,
		stopped = false,
		class: className
	}: {
		status: AgentRunStatus;
		/** A failed run the user stopped on purpose: shown neutral, not as an error. */
		stopped?: boolean;
		/** Show the status word next to the icon (a pill), instead of an icon tile. */
		label?: boolean;
		class?: string;
	} = $props();

	const text = $derived(
		status === 'running'
			? 'Running'
			: status === 'success'
				? 'Succeeded'
				: status === 'awaiting_input'
					? 'Needs you'
					: status === 'dismissed'
						? 'Dismissed'
						: stopped
							? 'Stopped'
							: 'Failed'
	);
	const tone = $derived(
		(stopped && status === 'failed') || status === 'dismissed'
			? 'bg-muted text-muted-foreground'
			: status === 'running'
				? 'bg-info/15 text-info-foreground'
				: status === 'success'
					? 'bg-success/15 text-success-foreground'
					: status === 'awaiting_input'
						? 'bg-warning/15 text-warning-foreground'
						: 'bg-destructive/10 text-destructive'
	);
</script>

{#snippet icon(size: string)}
	{#if status === 'running'}
		<LoaderCircleIcon class="{size} animate-spin" aria-hidden="true" />
	{:else if status === 'success'}
		<CircleCheckIcon class={size} aria-hidden="true" />
	{:else if status === 'awaiting_input'}
		<CircleAlertIcon class={size} aria-hidden="true" />
	{:else if status === 'dismissed'}
		<CircleMinusIcon class={size} aria-hidden="true" />
	{:else if stopped}
		<CircleStopIcon class={size} aria-hidden="true" />
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
