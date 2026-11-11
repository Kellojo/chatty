<script lang="ts">
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button/index.js';
	import { isMac } from '$lib/state/shortcuts.js';

	let {
		saveLabel,
		busyLabel = 'Saving…',
		canSave = true,
		busy = false,
		missing = null,
		dirty = false,
		onsave,
		ondiscard,
		cancel,
		escHint = false
	}: {
		/** e.g. "Save changes" or "Create agent". */
		saveLabel: string;
		/** Announced to screen readers while `busy`, e.g. "Creating…". */
		busyLabel?: string;
		/** Extra conditions for saving; it's also disabled while busy or something is missing. */
		canSave?: boolean;
		busy?: boolean;
		/** Why it can't be saved yet, e.g. "Add a name to create." Wins over `dirty`. */
		missing?: string | null;
		/** Shows "Unsaved changes" (and Discard, when given). Leave false on create forms. */
		dirty?: boolean;
		/** Click handler for the save button; without it the button submits its form. */
		onsave?: () => void;
		/** Reverts the edits, after asking; the button only shows while there are some. */
		ondiscard?: () => void;
		/** An always-visible Cancel: a link (create forms that leave the page) or a handler. */
		cancel?: string | (() => void);
		/** Also mention Esc in the shortcut hint. */
		escHint?: boolean;
	} = $props();

	const missingId = $props.id();

	// The server can't know the platform; switch after hydration so the markup matches.
	let mod = $state('Ctrl');
	$effect(() => {
		if (isMac) mod = '⌘';
	});

	const disabled = $derived(!canSave || busy || !!missing);
	const unsaved = $derived(!missing && dirty);
	// The shortcut does nothing while something is missing, so only advertise it when it works.
	const hint = $derived(
		[!missing && `${mod}+S to save`, escHint && 'Esc to cancel'].filter(Boolean).join(' · ')
	);
	// With nothing to say and only a disabled button, phones don't need it pinned on screen.
	const idle = $derived(!missing && !dirty && !cancel);

	function discard() {
		if (confirm('Discard your unsaved changes?')) ondiscard?.();
	}
</script>

<!-- A full-width strip pinned to the bottom of the scroll area. It stays in flow, so the last
	section always scrolls clear of it. -->
<div
	class="bottom-0 z-20 flex flex-wrap items-center justify-end gap-x-2 gap-y-2.5 bleed-x-bar pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] {idle
		? 'sm:sticky'
		: 'sticky'}"
>
	<p
		class="flex min-w-0 items-center text-xs text-muted-foreground max-sm:w-full sm:mr-auto {missing ||
		unsaved
			? ''
			: 'max-sm:hidden'}"
	>
		{#if missing}
			<span id={missingId}>{missing}</span>
		{/if}
		<!-- Only the unsaved and saving states are announced; the hint above changes as you type. -->
		<span class="flex items-center gap-2" aria-live="polite">
			{#if busy}
				<span class="sr-only">{busyLabel}</span>
			{:else if unsaved}
				<span class="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true"></span>
				Unsaved changes
			{/if}
		</span>
		{#if hint}
			<span class="hidden truncate md:inline">
				{#if missing || unsaved}<span class="mx-1.5" aria-hidden="true">·</span>{/if}{hint}
			</span>
		{/if}
	</p>
	<div class="flex gap-2 max-sm:w-full max-sm:*:h-10 max-sm:*:flex-1">
		{#if ondiscard && dirty}
			<Button variant="outline" disabled={busy} onclick={discard}>Discard</Button>
		{/if}
		<!-- Leaving mid-save would orphan the request. -->
		{#if typeof cancel === 'string'}
			<Button
				variant="outline"
				href={busy ? undefined : cancel}
				aria-disabled={busy || undefined}
				class={busy ? 'pointer-events-none opacity-50' : ''}>Cancel</Button
			>
		{:else if cancel}
			<Button variant="outline" disabled={busy} onclick={cancel}>Cancel</Button>
		{/if}
		<!-- Full contrast while saving, so the spinner reads as working rather than blocked. -->
		<Button
			type={onsave ? 'button' : 'submit'}
			onclick={onsave}
			{disabled}
			aria-describedby={missing ? missingId : undefined}
			class={busy ? 'disabled:opacity-100' : ''}
		>
			{#if busy}<LoaderCircleIcon class="size-4 animate-spin" aria-hidden="true" />{/if}
			{saveLabel}
		</Button>
	</div>
</div>
