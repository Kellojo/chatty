<script lang="ts">
	import { resolve } from '$app/paths';
	import AgentEditor from '$lib/components/app/AgentEditor.svelte';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>New agent · Chatty</title></svelte:head>

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto w-full max-w-6xl p-4 md:p-6">
		<div class="flex w-full flex-col gap-6">
			<PageHeader
				title="New agent"
				back={{ href: resolve('/agents'), label: 'Agents' }}
				description="Give it instructions, choose what it runs on and when it starts."
			/>
			<AgentEditor
				agent={null}
				groups={data.groups}
				mappings={data.mappings}
				tools={data.tools}
				codingEnvironments={data.codingEnvironments}
				timeFormat={data.timeFormat}
			/>
		</div>
	</div>
</div>
