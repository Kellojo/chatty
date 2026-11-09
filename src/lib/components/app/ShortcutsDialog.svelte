<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { SHORTCUT_GROUPS } from '$lib/state/shortcuts.js';
	import ShortcutKeys from './ShortcutKeys.svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	// Open on the list (scrollable with the arrow keys on small screens), not on the footer link.
	let listEl = $state<HTMLElement | null>(null);

	// A cheat sheet: two columns side by side on wider screens, so the whole list
	// fits without scrolling. The split keeps the columns about the same height.
	const columns = [SHORTCUT_GROUPS.slice(0, 2), SHORTCUT_GROUPS.slice(2)];
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_1fr_auto] gap-5 lg:max-w-4xl"
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			listEl?.focus();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>Keyboard shortcuts</Dialog.Title>
			<Dialog.Description class="sr-only">Every keyboard shortcut in Chatty.</Dialog.Description>
		</Dialog.Header>
		<!-- Focused on open, so the arrow keys and Page Up/Down scroll it when it doesn't fit. -->
		<div
			bind:this={listEl}
			tabindex="-1"
			role="region"
			aria-label="Shortcut list"
			class="-mx-1 grid min-h-0 gap-x-10 gap-y-4 overflow-y-auto rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 lg:grid-cols-2"
		>
			{#each columns as column, i (i)}
				<div class="flex flex-col gap-4">
					{#each column as group (group.title)}
						<section>
							<h3 class="pb-1 text-xs font-medium text-muted-foreground">{group.title}</h3>
							<dl>
								{#each group.entries as entry (entry.label)}
									<div class="flex items-center justify-between gap-4 py-1">
										<dt class="min-w-0 text-sm">
											{entry.label}
											{#if entry.description}
												<span class="block text-xs text-muted-foreground">{entry.description}</span>
											{/if}
										</dt>
										<dd><ShortcutKeys {entry} /></dd>
									</div>
								{/each}
							</dl>
						</section>
					{/each}
				</div>
			{/each}
		</div>
		{#if page.url.pathname !== '/settings/shortcuts'}
			<p class="border-t pt-3 text-xs text-muted-foreground">
				Also listed in
				<a
					href={resolve('/settings/shortcuts')}
					class="text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
					onclick={() => (open = false)}>Settings → Keyboard shortcuts</a
				>
			</p>
		{/if}
	</Dialog.Content>
</Dialog.Root>
