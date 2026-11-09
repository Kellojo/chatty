<script lang="ts">
	import InfoIcon from '@lucide/svelte/icons/info';
	import AgentEditor from '$lib/components/app/AgentEditor.svelte';
	import AgentHeader from '$lib/components/app/AgentHeader.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const builtin = $derived(data.agent.userId === null);
	// Bumped to discard edits: remounts the editor from the saved agent.
	let resets = $state(0);
</script>

<svelte:head><title>{data.agent.name} · Agents · Chatty</title></svelte:head>

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto w-full max-w-6xl p-4 *:max-w-4xl md:p-6">
		<div class="flex w-full flex-col gap-6">
			<AgentHeader agent={data.agent} active="setup" />
			{#if builtin}
				<p
					class="flex items-start gap-2 rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
				>
					<InfoIcon class="mt-0.5 size-4 shrink-0" />
					Built-in agents ship with Chatty, so their setup can't be changed. You can still turn them on
					or off and run them.
				</p>
			{/if}
			<!-- Keyed so switching between agents starts the form over. -->
			{#key `${data.agent.id}:${resets}`}
				<AgentEditor
					agent={data.agent}
					groups={data.groups}
					mappings={data.mappings}
					tools={data.tools}
					codingEnvironments={data.codingEnvironments}
					timeFormat={data.timeFormat}
					readonly={builtin}
					onreset={() => resets++}
				/>
			{/key}
		</div>
	</div>
</div>
