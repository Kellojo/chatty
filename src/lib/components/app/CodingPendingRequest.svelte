<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button, type ButtonVariant } from '$lib/components/ui/button/index.js';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import MessageCircleQuestionMarkIcon from '@lucide/svelte/icons/message-circle-question-mark';
	import ShieldQuestionMarkIcon from '@lucide/svelte/icons/shield-question-mark';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import {
		acceptsTypedAnswer,
		type CodingPendingOption,
		type CodingPendingRequest
	} from '$lib/coding-environments.js';

	let {
		conversationId,
		request,
		onresponded,
		onrespond
	}: {
		conversationId: string;
		request: CodingPendingRequest;
		/** Called after the server accepted the answer (e.g. to refetch task state). */
		onresponded?: () => void;
		/**
		 * Delivers the answer instead of the coding task's respond endpoint (an
		 * agent's `ask_user` question, answered by the next chat message).
		 * Resolves false when it wasn't sent.
		 */
		onrespond?: (answer: { optionId?: string; text?: string }) => Promise<boolean>;
	} = $props();

	/** The option being sent (its id), null when idle. */
	let sending = $state<string | null>(null);
	const busy = $derived(sending !== null);

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

	const isApproval = $derived(request.kind === 'approval');
	/** The real choices; handing the decision back is a quieter action of its own. */
	const choices = $derived(request.options.filter((o) => o.id !== request.deferOptionId));
	const deferOption = $derived(request.options.find((o) => o.id === request.deferOptionId));
	/**
	 * The highlighted choice: the recommended one. Without a recommendation only an
	 * approval's first decision (accept) is the primary action; a question's first
	 * option isn't singled out.
	 */
	const primaryId = $derived(
		request.recommendedOptionId ?? (isApproval ? choices[0]?.id : undefined)
	);
	const recommended = $derived(choices.find((o) => o.id === request.recommendedOptionId));
	/**
	 * Typed answers go through the composer right below (ChatView routes them to
	 * the request), so the panel has no reply box of its own; it only says so
	 * when there are buttons to pick from instead.
	 */
	const typedHint = $derived.by(() => {
		if (choices.length === 0) return null;
		// An agent's answer is simply the next message, whatever it says.
		if (onrespond) return request.allowFreeText ? 'Or type your own answer below.' : null;
		if (!acceptsTypedAnswer(request)) return null;
		return isApproval ? 'Or type below to decline with a note.' : 'Or type your own answer below.';
	});
	/** A question's header (T3) reads as its label, an approval's detail as context. */
	const header = $derived(!isApproval && request.detail ? request.detail : null);
	const body = $derived(isApproval ? request.detail : null);
	const longTitle = $derived(request.title.length > 120);
	/** Whether a scroll box (long question, approval reason) has more below its visible part. */
	const clipped = $state({ title: false, body: false, code: false });
	const FADE = '[mask-image:linear-gradient(to_bottom,black_80%,transparent)]';

	/** Keeps `clipped[key]` in step with its scroll box, for the fade at the cut-off edge. */
	const trackClipping = (key: keyof typeof clipped) => (box: HTMLElement) => {
		const update = () => {
			clipped[key] = box.scrollTop + box.clientHeight < box.scrollHeight - 1;
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(box);
		box.addEventListener('scroll', update, { passive: true });
		return () => {
			observer.disconnect();
			box.removeEventListener('scroll', update);
		};
	};

	/** Prose with file paths set in code type (an approval's reason often lists them). */
	function withPaths(text: string): { text: string; path: boolean }[] {
		// A capturing split keeps the matches at the odd indexes.
		return text
			.split(/((?:[\w.-]+\/)*[\w.-]*\w\.[a-z]{1,5}\b)/i)
			.map((part, i) => ({ text: part, path: i % 2 === 1 }))
			.filter((part) => part.text !== '');
	}

	/** Questions whose options carry explanations render as a stacked list so they're readable. */
	const hasDescriptions = $derived(choices.some((o) => o.description));

	function isDestructive(option: CodingPendingOption): boolean {
		return /^(decline|deny|reject|cancel|abort)/i.test(option.id);
	}

	function variantFor(option: CodingPendingOption): ButtonVariant {
		if (isDestructive(option)) return 'outline';
		return option.id === primaryId ? 'default' : 'outline';
	}

	async function respond(key: string, body: { optionId?: string; text?: string }) {
		// Buttons stay focusable while an answer sends (aria-disabled, so keyboard
		// users keep their place if it fails); this is what keeps them inert.
		if (busy) return;
		sending = key;
		try {
			if (onrespond) {
				if (await onrespond(body)) {
					onresponded?.();
				}
				return;
			}
			const res = await fetch(`/api/coding/tasks/${encodeURIComponent(conversationId)}/respond`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: request.requestId, ...body })
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(data?.message ?? 'Failed to send your answer');
			}
			onresponded?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to send your answer');
		} finally {
			sending = null;
		}
	}

	const choose = (option: CodingPendingOption) => respond(option.id, { optionId: option.id });

	let title = $state<HTMLElement | null>(null);
	const titleId = $props.id();

	// Mounted once per request: bring keyboard and screen-reader users to it by
	// focusing the question itself, never an answer (a stray Enter mustn't approve
	// a command). Not while the user is typing, and not for an agent's question,
	// which is mostly answered by typing in the composer.
	onMount(() => {
		if (onrespond) return;
		const active = document.activeElement as HTMLElement | null;
		if (active?.isContentEditable || active?.matches('input, textarea, select')) return;
		title?.focus();
	});
</script>

<!-- A plain region, so its controls aren't re-read on every change; ChatView's
     always-mounted live region announces each new request (pendingAnnouncement). -->
<section
	class="mb-2 overflow-hidden rounded-2xl border border-primary/30 bg-card shadow-sm"
	aria-labelledby={titleId}
	aria-busy={busy}
>
	<div class="flex flex-col gap-3 p-3 sm:p-4">
		<div class="flex flex-col gap-1">
			<p
				class="flex min-w-0 items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"
			>
				{#if isApproval}
					<ShieldQuestionMarkIcon class="size-3.5 shrink-0 text-primary" />
					<span class="text-primary">Needs your approval</span>
				{:else}
					<MessageCircleQuestionMarkIcon class="size-3.5 shrink-0 text-primary" />
					<span class="text-primary">Question for you</span>
					{#if header}
						<span aria-hidden="true">·</span>
						<span class="truncate normal-case">{header}</span>
					{/if}
				{/if}
			</p>
			<!-- A long question scrolls in its own box, reachable from the keyboard
			     (a scroll container must be focusable to scroll it without a mouse). -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				class={longTitle
					? [
							'max-h-40 overflow-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
							// Fades the cut-off edge while there is more to scroll.
							clipped.title && FADE
						]
					: ''}
				{@attach longTitle ? trackClipping('title') : undefined}
				tabindex={longTitle ? 0 : undefined}
			>
				<h2
					id={titleId}
					bind:this={title}
					tabindex="-1"
					class={[
						'mt-0.5 rounded-sm leading-snug text-pretty outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
						// A long question reads as prose, not as one heavy headline.
						longTitle ? 'text-sm' : 'text-[0.9375rem] font-medium'
					]}
				>
					{request.title}
				</h2>
			</div>
			{#if body}
				{#if detailIsCode}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable: must be keyboard-reachable) -->
					<pre
						class={[
							'mt-1 max-h-40 overflow-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
							clipped.code && FADE
						]}
						tabindex={clipped.code ? 0 : undefined}
						{@attach trackClipping('code')}>{body}</pre>
				{:else}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable: must be keyboard-reachable) -->
					<p
						class={[
							'max-h-40 overflow-auto rounded-sm text-sm whitespace-pre-wrap text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
							clipped.body && FADE
						]}
						tabindex={clipped.body ? 0 : undefined}
						{@attach trackClipping('body')}
					>
						{#each withPaths(body) as part, i (i)}{#if part.path}<code
									class="rounded bg-muted px-1 py-px font-mono text-xs text-foreground"
									>{part.text}</code
								>{:else}{part.text}{/if}{/each}
					</p>
				{/if}
			{/if}
		</div>

		{#if hasDescriptions}
			<div class="flex flex-col gap-1.5" role="group" aria-label="Answers">
				{#each choices as option (option.id)}
					{@const primary = option.id === primaryId}
					<button
						type="button"
						class={[
							'group flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
							'hover:border-primary/40 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
							'aria-disabled:pointer-events-none',
							busy && sending !== option.id && 'opacity-50',
							sending === option.id
								? 'border-primary bg-accent'
								: primary
									? 'border-primary/60'
									: 'border-border'
						]}
						aria-disabled={busy}
						onclick={() => choose(option)}
					>
						<span class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class="flex items-center gap-2 text-sm font-medium">
								{option.label}
								{#if primary && request.recommendedOptionId}
									<span
										class="rounded-full bg-primary/15 px-1.5 py-px text-xs font-medium text-primary"
										>Recommended</span
									>
								{/if}
							</span>
							{#if option.description}
								<span class="text-xs text-muted-foreground">{option.description}</span>
							{/if}
						</span>
						{#if sending === option.id}
							<span class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
								Sending…
								<LoaderCircleIcon class="size-4 animate-spin" />
							</span>
						{:else}
							<!-- Hints that the row answers, without a resting arrow on every row. -->
							<ChevronRightIcon
								class="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
							/>
						{/if}
					</button>
				{/each}
			</div>
		{:else if choices.length > 0}
			<!-- Three or more decisions stack on phones rather than leave one dangling. -->
			<div
				class={['flex flex-wrap gap-2', choices.length > 2 && 'max-sm:flex-col']}
				role="group"
				aria-label="Answers"
			>
				{#each choices as option (option.id)}
					<Button
						size="sm"
						variant={variantFor(option)}
						class={[
							// Thumb-sized on phones.
							'max-sm:h-10 max-sm:rounded-full max-sm:px-4',
							choices.length > 2 && 'max-sm:w-full',
							// Stays focusable while sending (aria-disabled), so dim it by hand.
							'aria-disabled:pointer-events-none',
							busy && sending !== option.id && 'opacity-50',
							isDestructive(option) &&
								'border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive'
						]}
						aria-disabled={busy}
						onclick={() => choose(option)}
					>
						{#if sending === option.id}
							<LoaderCircleIcon class="animate-spin" /><span class="sr-only">Sending…</span>
						{/if}
						{option.label}
						{#if option.id === recommended?.id}
							<span class="sr-only">, recommended</span>
							{#if variantFor(option) === 'default'}
								<!-- No pill in a pill: a quiet suffix on the filled button. -->
								<span aria-hidden="true" class="font-normal text-primary-foreground/70"
									>· Recommended</span
								>
							{:else}
								<span
									aria-hidden="true"
									class="ml-0.5 rounded-full bg-primary/15 px-1.5 py-px text-xs font-medium text-primary"
									>Recommended</span
								>
							{/if}
						{/if}
					</Button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- With nothing to choose, the composer's "Type your answer…" says it all. -->
	{#if typedHint || deferOption}
		<div
			class="-mt-2 flex items-center justify-end gap-2 px-3 pb-2 sm:mt-0 sm:min-h-10 sm:justify-between sm:border-t sm:bg-muted/40 sm:px-4 sm:py-1.5"
		>
			<!-- On phones "Decide yourself" stands alone; the composer says the rest. -->
			<span
				class={[
					'hidden text-xs text-muted-foreground transition-opacity sm:inline',
					busy && 'opacity-50'
				]}
			>
				{typedHint ?? ''}
			</span>
			{#if deferOption}
				<Button
					size="sm"
					variant="ghost"
					class={[
						'h-7 gap-1.5 px-2 text-xs aria-disabled:pointer-events-none max-sm:h-9 max-sm:px-3',
						busy && sending !== deferOption.id && 'opacity-50'
					]}
					aria-disabled={busy}
					onclick={() => choose(deferOption)}
				>
					{#if sending === deferOption.id}
						<LoaderCircleIcon class="size-3.5 animate-spin" /><span class="sr-only">Sending…</span>
					{:else}
						<SparklesIcon class="size-3.5" />
					{/if}
					{deferOption.label}
				</Button>
			{/if}
		</div>
	{/if}
</section>
