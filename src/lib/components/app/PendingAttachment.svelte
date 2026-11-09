<script lang="ts">
	import FileIcon from '@lucide/svelte/icons/file';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import FileSpreadsheetIcon from '@lucide/svelte/icons/file-spreadsheet';
	import XIcon from '@lucide/svelte/icons/x';

	let { file, onremove }: { file: File; onremove: () => void } = $props();

	const isImage = $derived(file.type.startsWith('image/'));
	const ext = $derived(/\.([a-z0-9]{1,6})$/i.exec(file.name)?.[1]?.toUpperCase() ?? '');

	// Screenshots get a timestamped name on paste (see clipboard-files.ts); the
	// stamp is noise on a small card, so show what it is instead.
	const label = $derived(isImage && /^pasted-\d{4}-/.test(file.name) ? 'Pasted image' : file.name);

	// Files without an extension (Dockerfile, nameless pastes) fall back to the MIME subtype.
	const kind = $derived(ext || file.type.split('/')[1]?.toUpperCase() || '');

	let previewUrl = $state<string>();
	$effect(() => {
		if (!isImage) return;
		const url = URL.createObjectURL(file);
		previewUrl = url;
		return () => {
			URL.revokeObjectURL(url);
			previewUrl = undefined;
		};
	});

	const Icon = $derived.by(() => {
		if (/^(CSV|XLSX?|ODS|TSV)$/.test(ext)) return FileSpreadsheetIcon;
		if (/^(JSON|XML|YA?ML|TOML|JS|TS|PY|HTML|CSS|SH|SQL)$/.test(ext)) return FileCodeIcon;
		if (file.type.startsWith('text/') || /^(TXT|MD|PDF|DOCX?|RTF|LOG)$/.test(ext))
			return FileTextIcon;
		return FileIcon;
	});

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<div class="group relative">
	<div
		class="flex h-14 max-w-56 min-w-36 items-center gap-2.5 rounded-xl border border-border/60 bg-muted/40 pr-3 pl-1.5 sm:h-16 sm:pl-2"
	>
		<div
			class="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background/70 text-muted-foreground ring-1 ring-border/50 sm:size-11"
		>
			{#if isImage}
				<img src={previewUrl} alt="" class="size-full object-cover" />
			{:else}
				<Icon class="size-5" />
			{/if}
		</div>
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm leading-5 font-medium" title={file.name}>{label}</p>
			<p class="truncate text-xs leading-4 text-muted-foreground">
				{kind ? `${kind} · ` : ''}{formatBytes(file.size)}
			</p>
		</div>
	</div>
	<button
		type="button"
		aria-label="Remove {label}"
		data-remove
		class="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-xs transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:size-7 pointer-fine:opacity-0"
		onclick={onremove}
	>
		<XIcon class="size-3.5" />
	</button>
</div>
