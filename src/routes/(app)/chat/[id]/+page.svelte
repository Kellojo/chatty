<script lang="ts">
	import ChatView from '$lib/components/app/ChatView.svelte';
	import { pickerModelGroups, syncModelCatalog } from '$lib/state/model-catalog.svelte.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const groups = $derived(pickerModelGroups(data.modelCatalog));
	$effect.pre(() => syncModelCatalog(data.modelCatalog));
</script>

{#key data.conversation.id}
	<ChatView
		conversation={data.conversation}
		initialMessages={data.messages}
		hasOlderMessages={data.hasOlderMessages}
		{groups}
		mappings={data.mappings}
		defaultModel={data.defaultModel}
		sttModel={data.sttModel}
		timeFormat={data.timeFormat}
		personas={data.personas}
		initiallyGenerating={data.generating}
		coding={data.coding ?? null}
		codingEnvironments={data.codingEnvironments}
		codingAgents={data.codingAgents}
		dispatch={data.dispatch}
	/>
{/key}
