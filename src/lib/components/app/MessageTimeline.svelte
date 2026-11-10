<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { SvelteMap } from 'svelte/reactivity';
	import { formatDateTime, formatMessageTime } from '$lib/datetime.js';
	import { cn } from '$lib/utils.js';
	import type { TimeFormat } from '$lib/user-settings.js';
	import { Markdown } from '$lib/components/ai/markdown/index.js';
	import { Message, MessageActions, MessageContent } from '$lib/components/ai/message/index.js';
	import ActivityGroup from './ActivityGroup.svelte';
	import HtmlRenderFrame from './HtmlRenderFrame.svelte';
	import GenerationInfoDialog from './GenerationInfoDialog.svelte';
	import { readHtmlRender } from '$lib/html-render.js';
	import { groupParts, hasVisibleContent } from './timeline.js';
	import { messageText } from '$lib/chat-history.js';
	import { readableErrorText } from '$lib/error-text.js';
	import { shortcutLabel } from '$lib/state/shortcuts.js';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import InfoIcon from '@lucide/svelte/icons/info';
	import FileIcon from '@lucide/svelte/icons/file';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { MessageUsage, UIMessage, UIMessageMetadata } from '$lib/types.js';

	let {
		messages,
		streaming = false,
		timeFormat = 'auto',
		messageTimes,
		onregenerate,
		onedit,
		onswitchbranch,
		ondeletebranch,
		branchDisabled = false,
		conversationId = null as string | null,
		editingId = null,
		class: className
	}: {
		messages: UIMessage[];
		streaming?: boolean;
		timeFormat?: TimeFormat;
		messageTimes?: ReadonlyMap<string, number>;
		onregenerate?: (messageId: string) => void;
		onedit?: (messageId: string, text: string) => void;
		/** Shows another version (`messageId`) of an edited message or regenerated reply. */
		onswitchbranch?: (messageId: string) => void;
		/** Deletes the shown version (`messageId`) and its replies; only offered with other versions. */
		ondeletebranch?: (messageId: string) => void;
		/** Versions can't be switched right now (a reply is streaming). */
		branchDisabled?: boolean;
		conversationId?: string | null;
		/** The user message being edited: it and everything after make way for the new version. */
		editingId?: string | null;
		class?: string;
	} = $props();

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	let usageMessageId = $state<string | null>(null);
	/** The version whose delete button was clicked once and waits for the confirming click. */
	let confirmDeleteId = $state<string | null>(null);
	const rotations = new SvelteMap<string, number>();
	const imgSizes = new SvelteMap<string, { w: number; h: number }>();

	function rotationFor(key: string): number {
		return rotations.get(key) ?? 0;
	}

	function rotate(key: string, delta: number) {
		rotations.set(key, (rotationFor(key) + delta + 360) % 360);
	}

	function isSideways(key: string): boolean {
		const r = rotationFor(key);
		return r === 90 || r === 270;
	}

	function onImgLoad(key: string, e: Event) {
		const img = e.currentTarget as HTMLImageElement;
		if (img.naturalWidth > 0) {
			imgSizes.set(key, { w: img.naturalWidth, h: img.naturalHeight });
		}
	}

	// When rotated 90/270 the image's visual box is width<->height swapped.
	// Constrain the img by the swapped axis so it fits the same footprint.
	function rotatedImgClass(key: string): string {
		if (!isSideways(key)) return 'max-h-96 w-auto max-w-full sm:max-w-md';
		const size = imgSizes.get(key);
		if (!size) return 'max-h-96 max-w-96';
		// visual width = rendered height; keep it within the same max bounds
		return size.w >= size.h ? 'max-h-96 w-auto max-w-96' : 'max-h-96 w-auto max-w-full';
	}

	function handleUsageOpenChange(open: boolean) {
		if (!open) usageMessageId = null;
	}

	function messageUsage(message: UIMessage): MessageUsage | null {
		const meta = message.metadata as { usage?: MessageUsage } | undefined;
		return meta?.usage ?? null;
	}

	function messageStatus(message: UIMessage): UIMessageMetadata {
		return (message.metadata as UIMessageMetadata | undefined) ?? {};
	}

	const lastAssistantIndex = $derived.by(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant') return i;
		}
		return -1;
	});

	const editingIndex = $derived(editingId ? messages.findIndex((m) => m.id === editingId) : -1);

	async function copyMessage(message: UIMessage) {
		try {
			await navigator.clipboard.writeText(messageText(message));
			toast.success('Copied to clipboard');
		} catch {
			toast.error('Failed to copy');
		}
	}
</script>

<div class={cn('mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6', className)}>
	{#each messages as message, index (message.id)}
		{@const status = messageStatus(message)}
		{@const messageActive = streaming && index === lastAssistantIndex}
		<!-- A reply that hasn't produced anything yet (or only bookkeeping parts like
		     `step-start`) renders nothing: the thinking indicator stands in for it. -->
		{@const visible = hasVisibleContent(message.parts)}
		{@const notice = status.status === 'failed' || (status.status === 'partial' && !messageActive)}
		{#if visible || notice}
			<Message
				class={cn(
					message.role === 'user' ? 'flex-col items-end' : 'flex-col items-start',
					editingIndex !== -1 && index >= editingIndex && 'opacity-50 transition-opacity'
				)}
			>
				{@const blocks = groupParts(message.parts)}
				{#each blocks as block, blockIndex (block.key)}
					{@const part = block.type === 'content' ? block.item.part : null}
					{@const partIndex = block.type === 'content' ? block.item.index : -1}
					{#if block.type === 'activity'}
						<ActivityGroup
							items={block.items as never}
							active={messageActive}
							live={messageActive && blockIndex === blocks.length - 1}
						/>
					{:else if part?.type === 'text'}
						{#if message.role === 'user'}
							<MessageContent class="max-w-[85%] whitespace-pre-wrap">{part.text}</MessageContent>
						{:else}
							<Markdown class="w-full max-w-none" content={part.text} {conversationId} />
						{/if}
					{:else if part && conversationId && readHtmlRender(part)}
						<HtmlRenderFrame {conversationId} {part} />
					{:else if part?.type === 'file'}
						{@const url = (part as { url?: string }).url ?? ''}
						{#if part.mediaType?.startsWith('image/')}
							{@const imgKey = `${message.id}:${partIndex}`}
							{@const rotation = rotationFor(imgKey)}
							<div
								class="group relative grid max-w-full place-items-center overflow-hidden rounded-md"
							>
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a href={url} target="_blank" rel="noopener" class="grid place-items-center">
									<img
										src={url}
										alt="Attachment"
										onload={(e) => onImgLoad(imgKey, e)}
										style:transform={rotation ? `rotate(${rotation}deg)` : undefined}
										class={cn('rounded-md border transition-transform', rotatedImgClass(imgKey))}
									/>
								</a>
								<div
									class="absolute right-2 bottom-2 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
								>
									<button
										type="button"
										title="Rotate left"
										aria-label="Rotate left"
										onclick={() => rotate(imgKey, -90)}
										class="flex size-8 items-center justify-center rounded-md border bg-background/80 text-foreground backdrop-blur-sm"
									>
										<RotateCcwIcon class="size-4" />
									</button>
									<button
										type="button"
										title="Rotate right"
										aria-label="Rotate right"
										onclick={() => rotate(imgKey, 90)}
										class="flex size-8 items-center justify-center rounded-md border bg-background/80 text-foreground backdrop-blur-sm"
									>
										<RotateCwIcon class="size-4" />
									</button>
									<a
										href={url}
										download
										title="Download image"
										aria-label="Download image"
										class="flex size-8 items-center justify-center rounded-md border bg-background/80 text-foreground backdrop-blur-sm"
									>
										<DownloadIcon class="size-4" />
									</a>
								</div>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</div>
						{:else}
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={url}
								target="_blank"
								rel="noopener"
								class="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
							>
								<FileIcon class="size-4" />
								{(part as { filename?: string }).filename ?? 'Attachment'}
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/if}
					{/if}
				{/each}
				{#if status.status === 'failed'}
					<div
						class="flex w-full items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
						role="alert"
					>
						<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 break-words"
							>{status.error ? readableErrorText(status.error) : 'The response failed.'}</span
						>
					</div>
				{:else if status.status === 'partial' && !messageActive}
					<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<CircleSlashIcon class="size-3.5" />
						Response stopped before it finished.
					</p>
				{/if}

				<MessageActions class={message.role === 'user' ? 'justify-end' : ''}>
					{#if mounted}
						{@const ts = messageTimes?.get(message.id)}
						{#if ts}
							<span
								class="text-xs text-muted-foreground tabular-nums"
								title={formatDateTime(ts, timeFormat)}
							>
								{formatMessageTime(ts, timeFormat)}
							</span>
						{/if}
					{/if}
					{@const branch = status.branch}
					{#if branch && branch.count > 1 && onswitchbranch}
						{@const prev = branch.ids[branch.index - 1]}
						{@const next = branch.ids[branch.index + 1]}
						<!-- Divided off so "delete this version" never reads as one of the message actions. -->
						<div
							class="mr-1 flex items-center border-r border-border/60 pr-1 text-xs text-muted-foreground tabular-nums"
							role="group"
							aria-label="Message versions"
						>
							<button
								title="Previous version"
								aria-label="Previous version"
								disabled={!prev || branchDisabled}
								class="rounded-md p-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 pointer-coarse:-my-1 pointer-coarse:p-2.5"
								onclick={() => prev && onswitchbranch(prev)}
							>
								<ChevronLeftIcon class="size-3.5" />
							</button>
							<span>{branch.index + 1} / {branch.count}</span>
							<button
								title="Next version"
								aria-label="Next version"
								disabled={!next || branchDisabled}
								class="rounded-md p-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 pointer-coarse:-my-1 pointer-coarse:p-2.5"
								onclick={() => next && onswitchbranch(next)}
							>
								<ChevronRightIcon class="size-3.5" />
							</button>
							{#if ondeletebranch}
								<!-- Deleting removes this version and its replies for good: the first
							     click only arms it. -->
								{@const confirming = confirmDeleteId === message.id}
								<button
									title={confirming ? 'Click again to delete this version' : 'Delete this version'}
									aria-label={confirming ? 'Confirm deleting this version' : 'Delete this version'}
									disabled={branchDisabled}
									class={cn(
										'ml-0.5 flex items-center gap-1 rounded-md p-1 hover:bg-accent disabled:pointer-events-none disabled:opacity-40 pointer-coarse:-my-1 pointer-coarse:p-2.5',
										confirming ? 'text-destructive' : 'hover:text-foreground'
									)}
									onclick={() => {
										if (confirming) {
											confirmDeleteId = null;
											ondeletebranch(message.id);
										} else {
											confirmDeleteId = message.id;
										}
									}}
									onblur={() => {
										if (confirming) confirmDeleteId = null;
									}}
								>
									<Trash2Icon class="size-3.5" />
									{#if confirming}<span>Delete?</span>{/if}
								</button>
							{/if}
						</div>
					{/if}
					{#if visible}
						<button
							title={index === lastAssistantIndex
								? `Copy (${shortcutLabel('copy-last-reply')})`
								: 'Copy'}
							aria-label="Copy message"
							class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:-my-1 pointer-coarse:p-2.5"
							onclick={() => copyMessage(message)}
						>
							<CopyIcon class="size-3.5" />
						</button>
					{/if}
					{#if message.role === 'user' && onedit && !streaming}
						<button
							title="Edit"
							aria-label="Edit message"
							class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:-my-1 pointer-coarse:p-2.5"
							onclick={() => onedit(message.id, messageText(message))}
						>
							<PencilIcon class="size-3.5" />
						</button>
					{/if}
					{#if message.role === 'assistant' && index === lastAssistantIndex && onregenerate && !streaming}
						<button
							title="Regenerate"
							aria-label="Regenerate response"
							class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:-my-1 pointer-coarse:p-2.5"
							onclick={() => onregenerate(message.id)}
						>
							<RefreshCwIcon class="size-3.5" />
						</button>
					{/if}
					{#if message.role === 'assistant' && messageUsage(message)}
						<button
							title="Generation info"
							aria-label="Generation info"
							class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:-my-1 pointer-coarse:p-2.5"
							onclick={() => (usageMessageId = message.id)}
						>
							<InfoIcon class="size-3.5" />
						</button>
					{/if}
				</MessageActions>
			</Message>
		{/if}
	{/each}

	{#if usageMessageId}
		{@const usageMessage = messages.find((m) => m.id === usageMessageId)}
		{@const usage = usageMessage ? messageUsage(usageMessage) : null}
		{#if usage}
			<GenerationInfoDialog {usage} open onOpenChange={handleUsageOpenChange} />
		{/if}
	{/if}
</div>

<style>
	:global(.reasoning-body ul),
	:global(.reasoning-body ol) {
		padding-left: 1.25rem;
		margin-top: 0.25em;
		margin-bottom: 0.25em;
	}

	:global(.reasoning-body li) {
		line-height: 1.6;
	}
</style>
