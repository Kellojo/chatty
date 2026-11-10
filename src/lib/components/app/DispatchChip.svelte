<script lang="ts">
	import { onMount } from 'svelte';
	import BotIcon from '@lucide/svelte/icons/bot';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { RUN_TRIGGER_LABELS } from '$lib/agent-labels.js';
	import { formatDateTime, formatMessageTime } from '$lib/datetime.js';
	import type { DispatchInfo } from '$lib/types.js';
	import type { TimeFormat } from '$lib/user-settings.js';
	import { cn } from '$lib/utils.js';

	let {
		dispatch,
		instructions,
		timeFormat = 'auto'
	}: {
		dispatch: DispatchInfo;
		/** The run's instructions: the chat's first message, written by Chatty. */
		instructions: string;
		timeFormat?: TimeFormat;
	} = $props();

	let open = $state(false);
	// Times depend on the viewer's clock and locale: render them only in the browser.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const panelId = $props.id();
	const who = $derived(
		dispatch.agentName ? `Started by ${dispatch.agentName}` : 'Started by a deleted agent'
	);
	const trigger = $derived(
		dispatch.trigger ? (RUN_TRIGGER_LABELS[dispatch.trigger] ?? dispatch.trigger) : null
	);
</script>

<div class="flex w-full flex-col items-center gap-2">
	<button
		type="button"
		class="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		aria-expanded={open}
		aria-controls={panelId}
		title={open ? 'Hide instructions' : 'Show instructions'}
		onclick={() => (open = !open)}
	>
		<BotIcon class="size-3.5 shrink-0" />
		<span class="truncate">
			{who}{#if trigger}&nbsp;· {trigger}{/if}{#if mounted && dispatch.startedAt}&nbsp;·
				<time
					datetime={new Date(dispatch.startedAt).toISOString()}
					title={formatDateTime(dispatch.startedAt, timeFormat)}
					class="tabular-nums">{formatMessageTime(dispatch.startedAt, timeFormat)}</time
				>{/if}
		</span>
		<ChevronDownIcon class={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
	</button>
	{#if open}
		<div
			id={panelId}
			class="w-full max-w-xl rounded-2xl border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
		>
			<p class="mb-1 text-xs font-medium tracking-wide uppercase">Instructions</p>
			<p class="break-words whitespace-pre-wrap text-foreground">{instructions}</p>
		</div>
	{/if}
</div>
