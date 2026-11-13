<script lang="ts">
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { ApiKey } from '$lib/types.js';
	import type { ApiScope } from './scopes.js';

	/** The keys that can do a task, or a prompt to create one. Step 1 of every guide. */
	let {
		scope,
		keys,
		onCreateKey,
		onEditKey
	}: {
		scope: ApiScope;
		keys: ApiKey[];
		onCreateKey: (scope: ApiScope) => void;
		onEditKey: (key: ApiKey) => void;
	} = $props();

	const matching = $derived(keys.filter((k) => k.scopes.includes(scope)));
</script>

<div
	class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3 py-2.5 {matching.length
		? 'bg-muted/50'
		: 'border border-dashed border-border'}"
>
	<KeyRoundIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	<p class="min-w-0 flex-1 text-sm text-muted-foreground">
		{#if matching.length === 0}
			Needs a key with the <code class="rounded bg-muted px-1 py-0.5 text-xs">{scope}</code> scope. You
			have none yet.
		{:else}
			Works with
			{#each matching as key, i (key.id)}{#if i > 0},
				{/if}<button
					type="button"
					class="font-medium text-foreground underline-offset-4 hover:underline"
					title="Edit {key.label}"
					onclick={() => onEditKey(key)}>{key.label}</button
				>{/each}
			<span class="whitespace-nowrap"
				>(<code class="rounded bg-muted px-1 py-0.5 text-xs">{scope}</code>)</span
			>
		{/if}
	</p>
	<Button
		size="sm"
		variant={matching.length ? 'ghost' : 'outline'}
		onclick={() => onCreateKey(scope)}
	>
		<PlusIcon class="size-4" />{matching.length ? 'New key' : 'Create key'}
	</Button>
</div>
