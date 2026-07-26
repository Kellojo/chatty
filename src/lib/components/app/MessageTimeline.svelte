<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { formatDateTime, formatMessageTime } from '$lib/datetime.js';
	import { formatCost, formatLatency, formatTokens } from '$lib/formats.js';
	import { cn } from '$lib/utils.js';
	import type { TimeFormat } from '$lib/user-settings.js';
	import { Markdown } from '$lib/components/ai/markdown/index.js';
	import { Message, MessageActions, MessageContent } from '$lib/components/ai/message/index.js';
	import { ToolCallCard } from '$lib/components/ai/tool-call-card/index.js';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import InfoIcon from '@lucide/svelte/icons/info';
	import FileIcon from '@lucide/svelte/icons/file';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import type { MessageUsage, UIMessage } from '$lib/types.js';

	let {
		messages,
		streaming = false,
		timeFormat = 'auto',
		messageTimes,
		onregenerate,
		onedit,
		class: className
	}: {
		messages: UIMessage[];
		streaming?: boolean;
		timeFormat?: TimeFormat;
		messageTimes?: ReadonlyMap<string, number>;
		onregenerate?: (messageId: string) => void;
		onedit?: (messageId: string, text: string) => void;
		class?: string;
	} = $props();

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	type Part = UIMessage['parts'][number];

	const openReasoning = new SvelteSet<string>();
	const openUsage = new SvelteSet<string>();
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

	function toggleUsage(key: string) {
		if (openUsage.has(key)) openUsage.delete(key);
		else openUsage.add(key);
	}

	function onWindowClick(event: MouseEvent) {
		if (openUsage.size === 0) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('[data-usage-popover]')) return;
		openUsage.clear();
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') openUsage.clear();
	}

	function messageUsage(message: UIMessage): MessageUsage | null {
		const meta = message.metadata as { usage?: MessageUsage } | undefined;
		return meta?.usage ?? null;
	}

	function tokensPerSecond(usage: MessageUsage): string {
		if (usage.outputTokens == null || usage.latencyMs == null || usage.latencyMs <= 0) return '—';
		return (usage.outputTokens / (usage.latencyMs / 1000)).toFixed(1);
	}

	function toggleReasoning(key: string) {
		if (openReasoning.has(key)) openReasoning.delete(key);
		else openReasoning.add(key);
	}

	function messageText(message: UIMessage): string {
		return message.parts
			.filter((p): p is Part & { type: 'text' } => p.type === 'text')
			.map((p) => p.text)
			.join('');
	}

	function isLastAssistant(index: number): boolean {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant') return i === index;
		}
		return false;
	}

	async function copyMessage(message: UIMessage) {
		try {
			await navigator.clipboard.writeText(messageText(message));
		} catch {
			toast.error('Failed to copy');
		}
	}

	function fileUrl(part: Part): string {
		return (part as { url?: string }).url ?? '';
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div class={cn('mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6', className)}>
	{#each messages as message, index (message.id)}
		<Message class={message.role === 'user' ? 'flex-col items-end' : 'flex-col items-start'}>
			{#each message.parts as part, partIndex (partIndex)}
				{#if part.type === 'text'}
					{#if message.role === 'user'}
						<MessageContent class="max-w-[85%]">{part.text}</MessageContent>
					{:else}
						<Markdown class="w-full max-w-none" content={part.text} />
					{/if}
				{:else if part.type === 'reasoning'}
					{@const key = `${message.id}:${partIndex}`}
					{@const reasoningStreaming =
						streaming && isLastAssistant(index) && partIndex === message.parts.length - 1}
					{@const open = openReasoning.has(key)}
					<div class="w-full">
						<button
							type="button"
							class="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
							aria-expanded={open}
							onclick={() => toggleReasoning(key)}
						>
							{#if reasoningStreaming}
								<span class="reasoning-pulse flex"><BrainIcon class="size-4" /></span>
								<span>Reasoning…</span>
							{:else}
								<BrainIcon class="size-4" />
								<span>Reasoning</span>
							{/if}
							<ChevronDownIcon class="size-4 transition-transform {open ? 'rotate-180' : ''}" />
						</button>
						{#if open}
							<div class="reasoning-body mt-2 border-l-2 border-border pl-3">
								<Markdown
									class="w-full max-w-none text-sm text-muted-foreground"
									content={part.text}
								/>
							</div>
						{/if}
					</div>
				{:else if part.type === 'file'}
					{@const url = fileUrl(part)}
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
								class="absolute right-2 bottom-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
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
				{:else if part.type.startsWith('tool-') || part.type === 'dynamic-tool'}
					<ToolCallCard part={part as never} />
				{/if}
			{/each}

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
				<button
					title="Copy"
					aria-label="Copy message"
					class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
					onclick={() => copyMessage(message)}
				>
					<CopyIcon class="size-3.5" />
				</button>
				{#if message.role === 'user' && onedit}
					<button
						title="Edit"
						aria-label="Edit message"
						class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						onclick={() => onedit(message.id, messageText(message))}
					>
						<PencilIcon class="size-3.5" />
					</button>
				{/if}
				{#if message.role === 'assistant' && isLastAssistant(index) && onregenerate && !streaming}
					<button
						title="Regenerate"
						aria-label="Regenerate response"
						class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						onclick={() => onregenerate(message.id)}
					>
						<RefreshCwIcon class="size-3.5" />
					</button>
				{/if}
				{#if message.role === 'assistant' && messageUsage(message)}
					{@const usage = messageUsage(message)!}
					{@const open = openUsage.has(message.id)}
					<div class="relative" data-usage-popover>
						<button
							title="Generation info"
							aria-label="Generation info"
							aria-expanded={open}
							class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
							onclick={() => toggleUsage(message.id)}
						>
							<InfoIcon class="size-3.5" />
						</button>
						{#if open}
							<div
								class="absolute bottom-full left-0 z-20 mb-1.5 w-60 overflow-hidden rounded-lg border border-border bg-popover text-xs shadow-lg shadow-black/5 dark:shadow-black/40"
							>
								<div class="border-b border-border/60 px-3 py-2">
									<div class="truncate font-mono text-[11px] text-foreground" title={usage.modelId}>
										{usage.modelId}
									</div>
									<div class="mt-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">
										Generation info
									</div>
								</div>
								<dl class="px-3 py-2">
									<div class="flex items-baseline justify-between py-0.5">
										<dt class="text-muted-foreground">Cost</dt>
										<dd class="text-sm font-medium text-foreground tabular-nums">
											{formatCost(usage.costUsd)}
										</dd>
									</div>
								</dl>
								<dl class="border-t border-border/60 px-3 py-2">
									<div class="flex items-baseline justify-between py-0.5">
										<dt class="text-muted-foreground">Input</dt>
										<dd class="text-foreground tabular-nums">{formatToken(usage.inputTokens)}</dd>
									</div>
									<div class="flex items-baseline justify-between py-0.5">
										<dt class="text-muted-foreground">Output</dt>
										<dd class="text-foreground tabular-nums">{formatToken(usage.outputTokens)}</dd>
									</div>
									<div class="flex items-baseline justify-between py-0.5">
										<dt class="text-muted-foreground">Total</dt>
										<dd class="text-foreground tabular-nums">{formatToken(usage.totalTokens)}</dd>
									</div>
								</dl>
								<dl class="border-t border-border/60 px-3 py-2">
									<div class="flex items-baseline justify-between py-0.5">
										<dt class="text-muted-foreground">Latency</dt>
										<dd class="text-foreground tabular-nums">{formatLatency(usage.latencyMs)}</dd>
									</div>
									<div class="flex items-baseline justify-between py-0.5">
										<dt class="text-muted-foreground">Throughput</dt>
										<dd class="text-foreground tabular-nums">{tokensPerSecond(usage)} tok/s</dd>
									</div>
								</dl>
							</div>
						{/if}
					</div>
				{/if}
			</MessageActions>
		</Message>
	{/each}
</div>

<style>
	.reasoning-pulse {
		animation: reasoning-pulse 1.4s ease-in-out infinite;
	}

	@keyframes reasoning-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

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
