<script lang="ts">
	// Screenshot harness (subagent-shots.svelte.spec.ts): tool rows inside a chat view's context.
	import { setChatViewContext } from '$lib/components/app/chat-view-context.js';
	import ToolCallCard from './ToolCallCard.svelte';

	let { rows }: { rows: { label: string; part: unknown; active: boolean }[] } = $props();

	setChatViewContext(() => ({
		conversationId: 'chat-1',
		codingEnvironments: [],
		codingAgents: []
	}));
</script>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-4 bg-background px-4 py-6 text-foreground">
	{#each rows as row (row.label)}
		<section data-row={row.label} class="flex flex-col gap-1">
			<p class="text-[10px] tracking-wide text-muted-foreground/60 uppercase">{row.label}</p>
			<ToolCallCard part={row.part as never} active={row.active} />
		</section>
	{/each}
</div>
