<script lang="ts">
	import { getContext } from 'svelte';
	import FileIcon from '@lucide/svelte/icons/file';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';

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
</script>

{#if data && url}
	<div class="my-2 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
		<FileIcon class="size-4 shrink-0 text-muted-foreground" />
		<span class="min-w-0 flex-1 truncate font-medium">{data.name}</span>
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a
			href={url}
			download
			class="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
			title="Download"
			aria-label="Download file"
		>
			<DownloadIcon class="size-3.5" />
		</a>
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			class="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
			title="Open in new tab"
			aria-label="Open file in new tab"
		>
			<ExternalLinkIcon class="size-3.5" />
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</div>
{/if}
