<script lang="ts">
	// A coding chat's reply with file links, wired to the file viewer the way ChatView does it.
	import { setContext } from 'svelte';
	import Markdown from '$lib/components/ai/markdown/markdown.svelte';
	import CodingFileDialog from '$lib/components/app/CodingFileDialog.svelte';
	import CodingDiffDialog from '$lib/components/app/CodingDiffDialog.svelte';
	import CheckpointCard from '$lib/components/app/CheckpointCard.svelte';
	import type { PartLike } from '$lib/components/app/timeline.js';
	import {
		CODING_FILES_CONTEXT,
		type CodingFileRef,
		type CodingFilesViewer
	} from '$lib/coding-file-links.js';

	let {
		content,
		enabled = true,
		checkpoint = null
	}: { content: string; enabled?: boolean; checkpoint?: PartLike | null } = $props();
	let changesOpen = $state(false);

	let file = $state<CodingFileRef | null>(null);
	let open = $state(false);
	setContext<CodingFilesViewer>(CODING_FILES_CONTEXT, {
		get enabled() {
			return enabled;
		},
		open(ref) {
			file = ref;
			open = true;
		},
		openChanges() {
			changesOpen = true;
		}
	});
</script>

<div class="mx-auto max-w-3xl p-4">
	<Markdown {content} conversationId="c-1" streaming={false} />
	{#if checkpoint}
		<div class="mt-4"><CheckpointCard part={checkpoint} /></div>
	{/if}
</div>
<CodingDiffDialog conversationId="c-1" bind:open={changesOpen} />
<CodingFileDialog conversationId="c-1" {file} bind:open />
