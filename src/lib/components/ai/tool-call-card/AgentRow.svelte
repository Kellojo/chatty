<script lang="ts" module>
	/** How an agent's row reads at a glance; picks its icon and status colour. */
	export type AgentRowTone = 'working' | 'done' | 'failed' | 'asking' | 'stopped';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import MessageCircleQuestionIcon from '@lucide/svelte/icons/message-circle-question';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { cn } from '$lib/utils.js';

	/**
	 * The one look every agent shares in a timeline: a coding task's subagents,
	 * Chatty's subagents (`run_subagent`) and agent runs (`start_agent`). Two
	 * lines (what it works on, then what it's doing or found), status and time
	 * on the right; clicking opens the details, links included (no buttons on the row itself).
	 */
	let {
		tone,
		status,
		statusShort,
		title,
		titleHint,
		leading,
		activity = null,
		activityInBody = false,
		duration = null,
		durationHint,
		open = $bindable(false),
		body
	}: {
		tone: AgentRowTone;
		/** The status word on the right ("Working", "Done"…). */
		status: string;
		/** A shorter status word for phones. */
		statusShort?: string;
		title: string;
		titleHint?: string;
		/** Before the title, e.g. the coding agent's provider mark. */
		leading?: Snippet;
		/** Second line: what it's doing, found, or why it stopped. */
		activity?: string | null;
		/** The opened body says it in full (a report, an error, a question): hide the line then. */
		activityInBody?: boolean;
		duration?: string | null;
		durationHint?: string;
		open?: boolean;
		/** The details shown when the row is opened; without it the row doesn't open. */
		body?: Snippet;
	} = $props();

	const bodyId = $props.id();
	const working = $derived(tone === 'working');
</script>

{#snippet rowContent()}
	<span class="flex h-5 w-5 shrink-0 items-center justify-center">
		{#if working}
			<Loader2Icon class="size-4 animate-spin text-info motion-reduce:animate-none" />
		{:else if tone === 'done'}
			<CircleCheckIcon class="size-4 text-success" />
		{:else if tone === 'asking'}
			<MessageCircleQuestionIcon class="size-4 text-warning" />
		{:else if tone === 'failed'}
			<TriangleAlertIcon class="size-4 text-destructive" />
		{:else}
			<CircleSlashIcon class="size-4 text-muted-foreground" />
		{/if}
	</span>
	<span class="flex min-w-0 flex-1 flex-col">
		<span class="flex min-w-0 items-center gap-1.5">
			{@render leading?.()}
			<span class="truncate font-medium text-foreground/90" title={titleHint ?? title}>{title}</span
			>
		</span>
		{#if activity && !(open && activityInBody)}
			<span
				class={cn(
					'text-xs',
					// What needs reading (a question, why it failed) gets two lines.
					tone === 'asking'
						? 'line-clamp-2 break-words'
						: // An error gets a second line only where the row is narrow; the body has all of it.
							tone === 'failed'
							? 'break-words max-sm:line-clamp-2 sm:truncate'
							: 'truncate',
					working ? 'text-info-foreground' : 'text-muted-foreground',
					tone === 'failed' && 'text-destructive/80',
					tone === 'asking' && 'text-foreground/80'
				)}
				title={activity}>{activity}</span
			>
		{/if}
	</span>
	<span
		class={cn(
			'flex h-5 shrink-0 items-center gap-1.5 pl-2 text-xs whitespace-nowrap',
			working && 'text-info-foreground',
			tone === 'done' && 'text-success-foreground',
			tone === 'asking' && 'text-warning-foreground',
			tone === 'failed' && 'text-destructive',
			tone === 'stopped' && 'text-muted-foreground'
		)}
	>
		{#if statusShort}
			<span class="sm:hidden">{statusShort}</span>
			<span class="max-sm:hidden">{status}</span>
		{:else}
			{status}
		{/if}
		{#if duration}
			<span class="text-muted-foreground tabular-nums" title={durationHint}>· {duration}</span>
		{/if}
		<ChevronRightIcon
			aria-hidden="true"
			class={cn(
				'size-3.5 text-muted-foreground transition motion-reduce:transition-none',
				body
					? 'opacity-50 group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100 pointer-coarse:opacity-80'
					: 'invisible',
				open && 'rotate-90 opacity-100'
			)}
		/>
	</span>
{/snippet}

<div class="flex w-full min-w-0 flex-col text-sm">
	<div class="flex w-full min-w-0 items-start">
		<!-- A row with nothing to open is plain text, not a disabled button. -->
		{#if body}
			<button
				type="button"
				class={cn(
					'group/tool flex w-full min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
					'aria-expanded:bg-accent/40'
				)}
				aria-expanded={open}
				aria-controls={bodyId}
				onclick={() => (open = !open)}
			>
				{@render rowContent()}
			</button>
		{:else}
			<div class="group/tool flex w-full min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-1.5">
				{@render rowContent()}
			</div>
		{/if}
	</div>
	{#if open && body}
		<div
			id={bodyId}
			class="mt-1 mb-2 ml-[1.0625rem] flex flex-col gap-2.5 border-l border-border pl-5"
		>
			{@render body()}
		</div>
	{/if}
</div>
