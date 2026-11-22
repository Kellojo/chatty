<script lang="ts">
	// Inline code. In a coding chat, a span that names a file (`src/a.ts:42`)
	// links to it like a markdown file link does (see markdown-link.svelte).
	import { getContext, type Snippet } from 'svelte';
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import { cn } from '$lib/utils';
	import {
		CODING_FILES_CONTEXT,
		INSIDE_LINK_CONTEXT,
		codingFileHref,
		followCodingFileLink,
		parseInlineCodeFileRef,
		type CodingFilesViewer
	} from '$lib/coding-file-links.js';

	type Props = { class?: string; children?: Snippet; token?: { text?: string } };
	let { class: className, children, token }: Props = $props();

	const conversationId = getContext<string | null | undefined>('conversationId');
	const codingFiles = getContext<CodingFilesViewer | undefined>(CODING_FILES_CONTEXT);
	const insideLink = getContext<boolean | undefined>(INSIDE_LINK_CONTEXT) === true;

	const ref = $derived(
		conversationId && codingFiles?.enabled && !insideLink
			? parseInlineCodeFileRef(token?.text ?? '')
			: null
	);
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- the chat's own URL -->
{#if ref && conversationId}
	<a
		data-coding-file
		href={codingFileHref(conversationId, ref)}
		title="Open {ref.path}"
		class="group/code rounded underline decoration-muted-foreground underline-offset-4 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		onclick={(event) => followCodingFileLink(event, codingFiles, ref)}
		><FileCodeIcon
			class="mr-0.5 inline size-3.5 -translate-y-px text-muted-foreground"
			aria-hidden="true"
		/><code class={cn(className, 'group-hover/code:bg-accent')}>{@render children?.()}</code></a
	>
{:else}
	<code class={className}>{@render children?.()}</code>
{/if}
