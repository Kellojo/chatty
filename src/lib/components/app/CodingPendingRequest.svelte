<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button, type ButtonVariant } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import MessageCircleQuestionMarkIcon from '@lucide/svelte/icons/message-circle-question-mark';
	import ShieldQuestionMarkIcon from '@lucide/svelte/icons/shield-question-mark';
	import type { CodingPendingOption, CodingPendingRequest } from '$lib/coding-environments.js';

	let {
		conversationId,
		request,
		onresponded
	}: {
		conversationId: string;
		request: CodingPendingRequest;
		/** Called after the server accepted the answer (e.g. to refetch task state). */
		onresponded?: () => void;
	} = $props();

	let busy = $state(false);
	let text = $state('');

	const COMMAND_START =
		/^(\$ |> |sudo |cd |ls|cat |rm |mv |cp |mkdir |git |npm |npx |pnpm |yarn |bun |node |python3? |pip |uv |cargo |go |make |docker |kubectl |curl |wget |bash |sh |pwsh |powershell )/;

	const detailIsCode = $derived.by(() => {
		const detail = request.detail?.trim();
		if (!detail) return false;
		if (/command|shell|exec|run/i.test(request.title)) return true;
		if (detail.startsWith('diff ') || detail.startsWith('--- ') || detail.startsWith('@@')) {
			return true;
		}
		return COMMAND_START.test(detail);
	});

	function variantFor(option: CodingPendingOption, index: number): ButtonVariant {
		if (/decline|deny|reject|cancel|abort/i.test(option.id)) return 'destructive';
		return index === 0 ? 'default' : 'outline';
	}

	async function respond(body: { optionId?: string; text?: string }) {
		if (busy) return;
		busy = true;
		try {
			const res = await fetch(`/api/coding/tasks/${encodeURIComponent(conversationId)}/respond`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: request.requestId, ...body })
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(data?.message ?? 'Failed to send your answer');
			}
			text = '';
			onresponded?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to send your answer');
		} finally {
			busy = false;
		}
	}

	function sendText() {
		const trimmed = text.trim();
		if (trimmed) void respond({ text: trimmed });
	}
</script>

<div
	class="mb-2 rounded-2xl border border-primary/30 bg-card p-3 shadow-sm"
	role="region"
	aria-label="Coding agent needs your input"
>
	<div class="flex items-start gap-2">
		{#if request.kind === 'approval'}
			<ShieldQuestionMarkIcon class="mt-0.5 size-4 shrink-0 text-primary" />
		{:else}
			<MessageCircleQuestionMarkIcon class="mt-0.5 size-4 shrink-0 text-primary" />
		{/if}
		<div class="min-w-0 flex-1">
			<p class="text-sm font-medium">{request.title}</p>
			{#if request.detail}
				{#if detailIsCode}
					<pre
						class="mt-1.5 max-h-40 overflow-auto rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap">{request.detail}</pre>
				{:else}
					<p class="mt-1 max-h-40 overflow-auto text-sm whitespace-pre-wrap text-muted-foreground">
						{request.detail}
					</p>
				{/if}
			{/if}
		</div>
	</div>

	{#if request.options.length > 0}
		<div class="mt-3 flex flex-wrap gap-2">
			{#each request.options as option, i (option.id)}
				<Button
					size="sm"
					variant={variantFor(option, i)}
					class={variantFor(option, i) === 'destructive' ? 'border-destructive/40' : ''}
					disabled={busy}
					onclick={() => respond({ optionId: option.id })}
				>
					{option.label}
				</Button>
			{/each}
		</div>
	{/if}

	{#if request.allowFreeText}
		<form
			class="mt-3 flex items-end gap-2"
			onsubmit={(e) => {
				e.preventDefault();
				sendText();
			}}
		>
			<Textarea
				bind:value={text}
				rows={1}
				class="max-h-40 min-h-9 py-2"
				placeholder={request.options.length > 0 ? 'Or type a reply…' : 'Type your answer…'}
				disabled={busy}
				onkeydown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
						e.preventDefault();
						sendText();
					}
				}}
			/>
			<Button type="submit" size="icon-sm" aria-label="Send answer" disabled={busy || !text.trim()}>
				<ArrowUpIcon />
			</Button>
		</form>
	{/if}
</div>
