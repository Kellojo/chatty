<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import CornerDownRightIcon from '@lucide/svelte/icons/corner-down-right';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlayIcon from '@lucide/svelte/icons/play';
	import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { QueuedMessage } from '$lib/state/message-queue.svelte.js';

	let {
		items,
		paused = false,
		busy = false,
		disabled = false,
		onsendnow,
		onedit,
		onremove,
		onresume
	}: {
		items: QueuedMessage[];
		/** The queue waits for the user instead of sending when the reply ends. */
		paused?: boolean;
		/** A reply is still running, so "send now" interrupts it. */
		busy?: boolean;
		/** A message is being sent right now; actions would race it. */
		disabled?: boolean;
		onsendnow: (item: QueuedMessage) => void;
		onedit: (item: QueuedMessage) => void;
		onremove: (item: QueuedMessage) => void;
		onresume: () => void;
	} = $props();

	function preview(item: QueuedMessage): string {
		const text = item.text.replace(/\s+/g, ' ').trim();
		if (text) return text;
		return item.files.length === 1 ? item.files[0].name : `${item.files.length} files`;
	}
</script>

<section
	class="mx-3 rounded-t-2xl border border-b-0 border-input bg-muted/40 px-2 pt-1.5 pb-1"
	aria-label="Queued messages"
>
	<div class="flex items-center justify-between gap-2 px-1.5 pb-1">
		<p class="text-xs text-muted-foreground">
			<span class="font-medium text-foreground">{items.length} queued</span>
			<span aria-hidden="true">·</span>
			{#if paused}
				Paused
			{:else if busy}
				Sends when the reply finishes
			{:else}
				Sending…
			{/if}
		</p>
		{#if paused}
			<Button variant="ghost" size="xs" {disabled} onclick={onresume}>
				<PlayIcon />
				{busy ? 'Resume' : 'Send next'}
			</Button>
		{/if}
	</div>
	<ul class="flex flex-col">
		{#each items as item (item.id)}
			<li class="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-muted">
				<CornerDownRightIcon class="size-3.5 shrink-0 text-muted-foreground" />
				<span class="min-w-0 flex-1 truncate text-sm" title={item.text || undefined}>
					{preview(item)}
				</span>
				{#if item.files.length > 0 && item.text.trim()}
					<span
						class="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
						title="{item.files.length} attached"
					>
						<PaperclipIcon class="size-3" />
						{item.files.length}
					</span>
				{/if}
				<div class="flex shrink-0 items-center gap-0.5">
					<Button
						variant="ghost"
						size="xs"
						{disabled}
						title={busy ? 'Stop the current reply and send this now' : 'Send this now'}
						onclick={() => onsendnow(item)}
					>
						<SendHorizontalIcon />
						Send now
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						{disabled}
						aria-label="Edit queued message"
						title="Edit"
						onclick={() => onedit(item)}
					>
						<PencilIcon />
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Remove queued message"
						title="Remove"
						onclick={() => onremove(item)}
					>
						<Trash2Icon />
					</Button>
				</div>
			</li>
		{/each}
	</ul>
</section>
