<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { MemoryWriteEntry } from '$lib/memory-types.js';

	let {
		entry,
		restoreBusy = false,
		onrestore
	}: {
		entry: MemoryWriteEntry;
		restoreBusy?: boolean;
		onrestore: (writeId: string) => void;
	} = $props();

	let open = $state(false);

	const actionClass = $derived(
		entry.action === 'create'
			? 'border-success/40 bg-success/10 text-success-foreground'
			: entry.action === 'delete'
				? ''
				: 'border-border bg-secondary text-secondary-foreground'
	);

	function formatTimestamp(timestamp: number): string {
		const diff = Date.now() - timestamp;
		const minute = 60_000;
		const hour = 60 * minute;
		if (diff < minute) return 'just now';
		if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
		if (diff < 24 * hour) return `${Math.floor(diff / hour)}h ago`;
		return new Date(timestamp).toLocaleString();
	}
</script>

<div class="rounded-md border bg-muted/30 text-sm">
	<div class="flex flex-col gap-1.5 px-3 py-2">
		<div class="flex items-center gap-2">
			<Badge variant={entry.action === 'delete' ? 'destructive' : 'outline'} class={actionClass}>
				{entry.action}
			</Badge>
			<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={entry.author}>
				{entry.author}
			</span>
			<span
				class="shrink-0 text-xs text-muted-foreground"
				title={new Date(entry.created_at).toLocaleString()}
			>
				{formatTimestamp(entry.created_at)}
			</span>
		</div>
		{#if entry.conversation_id || entry.agent_run_id}
			<div class="flex flex-col gap-0.5 text-xs text-muted-foreground">
				{#if entry.conversation_id}
					<span class="truncate" title={entry.conversation_id}>
						chat: {entry.conversation_id}
					</span>
				{/if}
				{#if entry.agent_run_id}
					<span class="truncate" title={entry.agent_run_id}>
						agent run: {entry.agent_run_id}
					</span>
				{/if}
			</div>
		{/if}
		{#if entry.diff}
			<div class="flex items-center justify-between gap-2">
				<button
					type="button"
					class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					aria-expanded={open}
					onclick={() => (open = !open)}
				>
					<ChevronDownIcon class="size-3.5 transition-transform {open ? 'rotate-180' : ''}" />
					Diff
				</button>
				<Button
					variant="ghost"
					size="xs"
					disabled={restoreBusy}
					onclick={() => onrestore(entry.id)}
				>
					<Undo2Icon class="size-3" />
					Restore
				</Button>
			</div>
		{/if}
	</div>
	{#if open && entry.diff}
		<pre
			class="max-h-64 overflow-x-auto border-t bg-background p-2 font-mono text-xs whitespace-pre">{entry.diff}</pre>
	{/if}
</div>
