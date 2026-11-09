<script lang="ts">
	import { onMount } from 'svelte';
	import { comboKeys, isMac, type ShortcutEntry } from '$lib/state/shortcuts.js';

	let { entry }: { entry: Pick<ShortcutEntry, 'combos' | 'separator'> } = $props();

	// The server can't tell a Mac; switch the keys over once mounted so hydration matches.
	let mac = $state(false);
	onMount(() => {
		mac = isMac;
	});

	// What a screen reader should say for keys it reads oddly ("upwards arrow", "place of interest sign").
	const SPOKEN: Record<string, string> = {
		'↑': 'Up arrow',
		'↓': 'Down arrow',
		'⌘': 'Command',
		'⌥': 'Option',
		'⇧': 'Shift',
		Esc: 'Escape',
		Ctrl: 'Control',
		'?': 'Question mark',
		'/': 'Slash',
		',': 'Comma',
		'.': 'Period'
	};
</script>

<span class="inline-flex shrink-0 items-center gap-1 align-middle text-xs text-muted-foreground">
	{#each entry.combos as combo, i (combo)}
		{#if i > 0}
			<span class="px-0.5">{entry.separator ?? 'or'}</span>
		{/if}
		<kbd class="inline-flex items-center gap-1 font-sans">
			{#each comboKeys(combo, mac) as key, k (k)}
				<span
					class="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-md border border-b-2 bg-muted px-1.5 font-mono text-[11px] leading-none text-foreground"
					><span aria-hidden="true">{key}</span><span class="sr-only">{SPOKEN[key] ?? key}</span
					></span
				>
			{/each}
		</kbd>
	{/each}
</span>
