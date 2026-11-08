<script lang="ts" module>
	import type { Component } from 'svelte';

	export type RowMenuItem =
		| {
				label: string;
				onSelect: () => void;
				icon?: Component<{ class?: string }>;
				destructive?: boolean;
				disabled?: boolean;
		  }
		| 'separator';
</script>

<script lang="ts">
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

	let {
		label,
		items
	}: { /** Names the row, e.g. "Actions for OpenAI". */ label: string; items: RowMenuItem[] } =
		$props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon-sm"
				class="relative"
				title="More actions"
				aria-label={label}
			>
				<EllipsisIcon class="size-4" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="min-w-40">
		{#each items as item, i (i)}
			{#if item === 'separator'}
				<DropdownMenu.Separator />
			{:else}
				<DropdownMenu.Item
					variant={item.destructive ? 'destructive' : 'default'}
					disabled={item.disabled}
					onclick={item.onSelect}
				>
					{#if item.icon}<item.icon class="size-4" />{/if}
					{item.label}
				</DropdownMenu.Item>
			{/if}
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
