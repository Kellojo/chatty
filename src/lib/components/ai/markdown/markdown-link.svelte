<script lang="ts" module>
	// One lookup per thread for the whole page, however often it is linked.
	// A plain cache, not reactive state: each link awaits its own promise.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const titles = new Map<string, Promise<string | null>>();

	function threadTitle(path: string): Promise<string | null> {
		let title = titles.get(path);
		if (!title) {
			title = fetch(`/api/coding/threads${path.slice('/t3-thread'.length)}`)
				.then((res) => (res.ok ? (res.json() as Promise<{ title?: string }>) : null))
				.then((body) => body?.title?.trim() || null)
				.catch(() => null);
			titles.set(path, title);
		}
		return title;
	}
</script>

<script lang="ts">
	// Links that streamdown renders as plain anchors (relative URLs, and links
	// when link safety is off). T3 thread links arrive already rewritten to
	// `/t3-thread/…` (see `urlTransform` in markdown.svelte); a bare one, whose
	// text is just the `t3-thread://` URL, is labelled with the thread's title.
	import { getContext, setContext, type Snippet } from 'svelte';
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import { cn } from '$lib/utils';
	import { parseT3ThreadLink, parseT3ThreadPath } from '$lib/t3-thread-links.js';
	import {
		CODING_FILES_CONTEXT,
		INSIDE_LINK_CONTEXT,
		followCodingFileLink,
		parseCodingFileHref,
		type CodingFilesViewer
	} from '$lib/coding-file-links.js';

	type Props = {
		href?: string;
		target?: string;
		rel?: string;
		title?: string | null;
		class?: string;
		children?: Snippet;
		token?: { text?: string };
	};

	let { href, target, rel, title, class: className, children, token }: Props = $props();

	const conversationId = getContext<string | null | undefined>('conversationId');
	const codingFiles = getContext<CodingFilesViewer | undefined>(CODING_FILES_CONTEXT);
	// Rewritten by `urlTransform` in markdown.svelte from a path on the coding machine.
	const codingFile = $derived(
		href && conversationId && codingFiles ? parseCodingFileHref(href, conversationId) : null
	);

	const openFile = (event: MouseEvent) => followCodingFileLink(event, codingFiles, codingFile);
	setContext(INSIDE_LINK_CONTEXT, true);

	const isThread = $derived(!!href && !!parseT3ThreadPath(href));
	// Autolinks (`<t3-thread://…>`) and links labelled with their own URL.
	const bare = $derived(isThread && !!token && !!parseT3ThreadLink(token.text ?? ''));

	let threadName = $state<string | null>(null);
	$effect(() => {
		threadName = null;
		if (!bare || !href) return;
		let current = true;
		void threadTitle(href).then((name) => {
			if (current) threadName = name;
		});
		return () => {
			current = false;
		};
	});
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs come from the message's markdown -->
{#if codingFile}
	<a
		data-streamdown="link"
		data-coding-file
		class={cn(className, 'inline-flex items-baseline gap-1')}
		{href}
		title={title ?? codingFile.path}
		onclick={openFile}
	>
		<FileCodeIcon class="size-3.5 shrink-0 self-center" aria-hidden="true" />
		<span>{@render children?.()}</span>
	</a>
{:else if isThread}
	<a
		data-streamdown="link"
		class={cn(className, 'inline-flex items-baseline gap-1')}
		{href}
		title={title ?? undefined}
	>
		<SquareTerminalIcon class="size-3.5 shrink-0 self-center" aria-hidden="true" />
		{#if bare}<span>{threadName ?? 'T3 thread'}</span>{:else}{@render children?.()}{/if}
	</a>
{:else}
	<a data-streamdown="link" class={className} {href} {target} {rel} title={title ?? undefined}
		>{@render children?.()}</a
	>
{/if}
