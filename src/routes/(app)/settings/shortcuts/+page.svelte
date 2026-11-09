<script lang="ts">
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import ShortcutKeys from '$lib/components/app/ShortcutKeys.svelte';
	import { COMBOS, SHORTCUT_GROUPS } from '$lib/state/shortcuts.js';
</script>

<svelte:head><title>Keyboard shortcuts · Settings · Chatty</title></svelte:head>

<SettingsHeader title="Keyboard shortcuts">
	{#snippet description()}
		Move around without the mouse. Press <ShortcutKeys
			entry={{ combos: [COMBOS['show-shortcuts']] }}
		/> anywhere to see this list.
	{/snippet}
</SettingsHeader>

{#each SHORTCUT_GROUPS as group (group.title)}
	<SettingsSection title={group.title} description={group.description}>
		<dl class="flex flex-col">
			{#each group.entries as entry (entry.label)}
				<div
					class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border/60 py-3 first:border-t-0 first:pt-0 last:pb-0"
				>
					<dt class="flex min-w-0 flex-col gap-1">
						<span class="text-sm font-medium">{entry.label}</span>
						{#if entry.description}
							<span class="text-sm text-muted-foreground">{entry.description}</span>
						{/if}
					</dt>
					<dd class="ml-auto"><ShortcutKeys {entry} /></dd>
				</div>
			{/each}
		</dl>
	</SettingsSection>
{/each}
