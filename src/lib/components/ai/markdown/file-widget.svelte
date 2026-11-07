<script lang="ts">
	import { getContext, type Component } from 'svelte';
	import FileIcon from '@lucide/svelte/icons/file';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import FileImageIcon from '@lucide/svelte/icons/file-image';
	import FileSpreadsheetIcon from '@lucide/svelte/icons/file-spreadsheet';
	import FileArchiveIcon from '@lucide/svelte/icons/file-archive';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import WidgetCard from './widget-card.svelte';

	type Payload = {
		name: string;
		path: string;
	};

	type Props = {
		code: string;
		isIncomplete: boolean;
	};

	let { code, isIncomplete }: Props = $props();

	const conversationId = getContext<string>('conversationId');

	const data = $derived.by((): Payload | null => {
		if (isIncomplete) return null;
		try {
			const parsed = JSON.parse(code) as Payload;
			if (typeof parsed !== 'object' || parsed === null) return null;
			if (typeof parsed.name !== 'string' || typeof parsed.path !== 'string') return null;
			return parsed;
		} catch {
			return null;
		}
	});

	const url = $derived.by(() => {
		if (!data) return null;
		const encodedPath = data.path.split('/').map(encodeURIComponent).join('/');
		return `/api/chat/${conversationId}/workspace-files/${encodedPath}`;
	});

	const KINDS: [RegExp, Component<{ class?: string }>][] = [
		[/^(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/, FileImageIcon],
		[/^(csv|tsv|xlsx?|ods)$/, FileSpreadsheetIcon],
		[/^(zip|tar|gz|tgz|7z|rar)$/, FileArchiveIcon],
		[
			/^(html?|css|js|ts|jsx|tsx|json|py|sh|svelte|xml|ya?ml|sql|go|rs|java|c|cpp|rb)$/,
			FileCodeIcon
		],
		[/^(md|txt|pdf|docx?|rtf|log)$/, FileTextIcon]
	];

	const ext = $derived(data?.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '');
	const icon = $derived(KINDS.find(([re]) => re.test(ext))?.[1] ?? FileIcon);
	// Show where the file lives when that adds something beyond its name.
	const subtitle = $derived.by(() => {
		if (!data) return null;
		const kind = ext ? `${ext.toUpperCase()} file` : 'File';
		return data.path !== data.name ? `${kind} · ${data.path}` : kind;
	});

	const action = buttonVariants({ variant: 'ghost', size: 'icon-sm' });
</script>

<WidgetCard
	{icon}
	status={data && url ? 'ready' : isIncomplete ? 'loading' : 'error'}
	loadingLabel="Preparing file…"
	errorLabel="Could not show file"
	raw={code}
	title={data?.name}
	{subtitle}
	divided={false}
>
	{#snippet meta()}
		{#if url}
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				class={action}
				title="Open in new tab"
			>
				<ExternalLinkIcon class="size-4" />
				<span class="sr-only">Open {data?.name} in new tab</span>
			</a>
			<a href={url} download class={action} title="Download">
				<DownloadIcon class="size-4" />
				<span class="sr-only">Download {data?.name}</span>
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
	{/snippet}
</WidgetCard>
