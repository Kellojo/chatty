<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import CommandPaletteList from './CommandPaletteList.svelte';

	/**
	 * The Mod+K command palette: one search box for every chat, page, agent,
	 * skill and action in the app. A keyboard power tool; nothing else depends on it.
	 */
	let {
		open = $bindable(false),
		isAdmin,
		onopenchat
	}: {
		open?: boolean;
		isAdmin: boolean;
		/** Opens a conversation (the shell also puts the cursor in its composer). */
		onopenchat: (id: string) => void;
	} = $props();

	// The chosen command runs only once the palette has closed and focus is back
	// where it was, so a command that opens a dialog (Rename…) keeps its focus.
	let pending: (() => unknown) | null = null;

	function choose(run: () => unknown) {
		pending = run;
		open = false;
	}

	function runPending() {
		const run = pending;
		pending = null;
		if (run) setTimeout(() => void run(), 0);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		showCloseButton={false}
		class="top-[max(1rem,12vh)] translate-y-0 gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-xl"
		onCloseAutoFocus={runPending}
	>
		<Dialog.Title class="sr-only">Command palette</Dialog.Title>
		<Dialog.Description class="sr-only">
			Search conversations, pages, agents and skills, or run an action.
		</Dialog.Description>
		<CommandPaletteList {isAdmin} {onopenchat} onchoose={choose} />
	</Dialog.Content>
</Dialog.Root>
