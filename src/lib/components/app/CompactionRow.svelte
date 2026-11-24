<script lang="ts">
	// A coding agent compacting its context, as a divider across the reply: while
	// it runs it reads like the "Thinking" row (shimmer and a live timer), so the
	// agent visibly is at work; afterwards it marks where earlier context was
	// summarised, with how much it shrank.
	import FoldVerticalIcon from '@lucide/svelte/icons/fold-vertical';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import type { Compaction } from '$lib/coding-compaction.js';
	import { formatCount, formatElapsed } from '$lib/formats.js';
	import { cn } from '$lib/utils.js';
	import LiveElapsed from './LiveElapsed.svelte';

	let { compaction }: { compaction: Compaction } = $props();

	const running = $derived(compaction.state === 'running');
	const label = $derived(
		running
			? 'Compacting context'
			: compaction.state === 'stopped'
				? 'Context compaction stopped'
				: 'Context compacted'
	);
	const detail = $derived.by(() => {
		if (running) return null;
		const { beforeTokens, afterTokens, startedAt, completedAt } = compaction;
		const parts: string[] = [];
		if (compaction.state === 'done' && beforeTokens !== null && afterTokens !== null) {
			parts.push(`${formatCount(beforeTokens)} → ${formatCount(afterTokens)} tokens`);
		}
		if (startedAt !== null && completedAt !== null && completedAt >= startedAt) {
			parts.push(formatElapsed(Math.max(1000, completedAt - startedAt)));
		}
		return parts.length > 0 ? parts.join(' · ') : null;
	});
</script>

<div
	class="flex w-full min-w-0 items-center gap-3 py-1 text-sm text-muted-foreground"
	role="status"
	aria-label={detail ? `${label}, ${detail}` : label}
>
	<span class="h-px min-w-4 flex-1 bg-border" aria-hidden="true"></span>
	<span class="flex min-w-0 items-center gap-2" aria-hidden="true">
		{#if running}
			<Loader2Icon class="size-3.5 shrink-0 animate-spin" />
			<span class="text-shimmer font-medium text-foreground/80">{label}</span>
			{#if compaction.startedAt !== null}
				<LiveElapsed since={compaction.startedAt} class="text-xs" />
			{/if}
		{:else}
			<FoldVerticalIcon class="size-3.5 shrink-0" />
			<span class={cn('font-medium', compaction.state === 'stopped' && 'italic')}>{label}</span>
			{#if detail}
				<span class="truncate text-xs tabular-nums">· {detail}</span>
			{/if}
		{/if}
	</span>
	<span class="h-px min-w-4 flex-1 bg-border" aria-hidden="true"></span>
</div>
