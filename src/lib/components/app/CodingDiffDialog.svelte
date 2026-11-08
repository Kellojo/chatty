<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FileDiffIcon from '@lucide/svelte/icons/file-diff';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		defaultDiffSource,
		type CodingDiffFile,
		type CodingDiffFileStatus,
		type CodingDiffSource,
		type CodingTaskDiff
	} from '$lib/coding-diff.js';
	import { formatCount } from '$lib/formats.js';

	/** The task's changed files with per-file diffs, read from T3 when opened. */
	let { conversationId, open = $bindable(false) }: { conversationId: string; open?: boolean } =
		$props();

	/** Lines shown per file before "Show more". */
	const PAGE_LINES = 400;
	/** Files expanded when the diff opens; bigger change sets start collapsed. */
	const AUTO_EXPAND_FILES = 8;

	let diff = $state<CodingTaskDiff | null>(null);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let sourceKind = $state<string | null>(null);
	const expanded = new SvelteSet<string>();
	/** Lines shown per expanded file, by path (absent = PAGE_LINES). */
	let shownLines = $state<Record<string, number>>({});
	let loadSeq = 0;

	const sources = $derived(diff?.sources.filter((s) => s.files.length > 0) ?? []);
	const source = $derived<CodingDiffSource | null>(
		sources.find((s) => s.kind === sourceKind) ?? (diff ? defaultDiffSource(diff.sources) : null)
	);
	const totals = $derived(
		(source?.files ?? []).reduce(
			(t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }),
			{ additions: 0, deletions: 0 }
		)
	);

	async function load() {
		const seq = ++loadSeq;
		loading = true;
		loadError = null;
		try {
			const res = await fetch(`/api/coding/tasks/${encodeURIComponent(conversationId)}/diff`);
			const data = (await res.json().catch(() => null)) as
				(CodingTaskDiff & { message?: string }) | null;
			if (!res.ok || !data) throw new Error(data?.message ?? 'Could not load the changes');
			if (seq !== loadSeq) return;
			diff = data;
			selectSource(defaultDiffSource(data.sources));
		} catch (e) {
			if (seq === loadSeq)
				loadError = e instanceof Error ? e.message : 'Could not load the changes';
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}

	function selectSource(next: CodingDiffSource | null) {
		sourceKind = next?.kind ?? null;
		expanded.clear();
		shownLines = {};
		const files = next?.files ?? [];
		if (files.length <= AUTO_EXPAND_FILES) for (const f of files) expanded.add(f.path);
	}

	function toggle(path: string) {
		if (expanded.has(path)) expanded.delete(path);
		else expanded.add(path);
	}

	$effect(() => {
		if (open) void load();
	});

	const STATUS: Record<CodingDiffFileStatus, { letter: string; label: string; tone: string }> = {
		added: { letter: 'A', label: 'Added', tone: 'text-success-foreground' },
		deleted: { letter: 'D', label: 'Deleted', tone: 'text-destructive' },
		renamed: { letter: 'R', label: 'Renamed', tone: 'text-muted-foreground' },
		modified: { letter: 'M', label: 'Modified', tone: 'text-muted-foreground' }
	};

	const LINE_CLASS = {
		add: 'bg-success/10',
		del: 'bg-destructive/10',
		context: '',
		hunk: 'bg-muted text-muted-foreground',
		meta: 'text-muted-foreground italic'
	} as const;
	const LINE_SIGN = { add: '+', del: '-', context: ' ', hunk: '', meta: '' } as const;

	const visibleLines = (file: CodingDiffFile) =>
		file.lines.slice(0, shownLines[file.path] ?? PAGE_LINES);
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex h-[calc(100dvh-2rem)] max-h-[60rem] w-full max-w-[calc(100vw-2rem)] flex-col gap-3 p-4 sm:max-w-5xl"
	>
		<Dialog.Header class="pr-10">
			<Dialog.Title class="flex items-center gap-2">
				<FileDiffIcon class="size-4" />
				Changes
				{#if source && source.files.length > 0}
					<span class="font-mono text-xs font-normal tabular-nums">
						<span class="text-success-foreground">+{formatCount(totals.additions)}</span>
						<span class="text-destructive">−{formatCount(totals.deletions)}</span>
					</span>
					<span class="text-xs font-normal text-muted-foreground">
						{source.files.length}
						{source.files.length === 1 ? 'file' : 'files'}
					</span>
				{/if}
				<Button
					variant="ghost"
					size="icon-sm"
					class="ml-auto text-muted-foreground"
					title="Refresh"
					aria-label="Refresh the changes"
					disabled={loading}
					onclick={() => void load()}
				>
					<RotateCwIcon class={loading ? 'animate-spin' : ''} />
				</Button>
			</Dialog.Title>
			<Dialog.Description class="sr-only">
				Files the coding agent changed, with their line-by-line differences.
			</Dialog.Description>
		</Dialog.Header>

		{#if sources.length > 1}
			<div class="flex gap-1" role="group" aria-label="Compare">
				{#each sources as s (s.kind)}
					<Button
						variant={s.kind === source?.kind ? 'secondary' : 'ghost'}
						size="sm"
						aria-pressed={s.kind === source?.kind}
						onclick={() => selectSource(s)}
					>
						{s.title}
					</Button>
				{/each}
			</div>
		{/if}

		<div class="min-h-0 flex-1 overflow-y-auto rounded-md border">
			{#if loading && !diff}
				<div class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
					<LoaderCircleIcon class="size-4 animate-spin" /> Loading changes…
				</div>
			{:else if loadError}
				<div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm">
					<p class="text-destructive">{loadError}</p>
					<Button variant="outline" size="sm" onclick={() => void load()}>Try again</Button>
				</div>
			{:else if !source || source.files.length === 0}
				<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
					No changes
				</div>
			{:else}
				{#if source.truncated}
					<p class="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
						This diff is large, so parts of it are left out.
					</p>
				{/if}
				{#each source.files as file (file.path)}
					{@const status = STATUS[file.status]}
					{@const isOpen = expanded.has(file.path)}
					<section class="border-b last:border-b-0">
						<button
							type="button"
							class="sticky top-0 z-10 flex w-full items-center gap-2 bg-background px-3 py-2 text-left text-sm hover:bg-accent"
							aria-expanded={isOpen}
							onclick={() => toggle(file.path)}
						>
							<ChevronRightIcon
								class="size-4 shrink-0 text-muted-foreground transition-transform {isOpen
									? 'rotate-90'
									: ''}"
							/>
							<span
								class="w-3 shrink-0 font-mono text-xs font-semibold {status.tone}"
								title={status.label}>{status.letter}</span
							>
							<span class="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
								{#if file.previousPath}
									<span class="text-muted-foreground">{file.previousPath} → </span>
								{/if}
								{file.path}
							</span>
							<span class="shrink-0 font-mono text-xs tabular-nums">
								<span class="text-success-foreground">+{formatCount(file.additions)}</span>
								<span class="text-destructive">−{formatCount(file.deletions)}</span>
							</span>
						</button>
						{#if isOpen}
							{#if file.binary}
								<p class="px-3 pb-2 text-xs text-muted-foreground">Binary file</p>
							{:else if file.lines.length === 0}
								<p class="px-3 pb-2 text-xs text-muted-foreground">
									{file.truncated ? 'Left out of this large diff.' : 'No line changes.'}
								</p>
							{:else}
								{@const shown = visibleLines(file)}
								<div class="overflow-x-auto">
									<pre
										class="min-w-max font-mono text-xs leading-5">{#each shown as line, i (i)}<div
												class="px-3 {LINE_CLASS[line.kind]}"><span
													class="inline-block w-3 text-muted-foreground select-none"
													aria-hidden="true">{LINE_SIGN[line.kind]}</span
												>{line.text}</div>{/each}</pre>
								</div>
								{#if shown.length < file.lines.length}
									<div class="px-3 py-1.5">
										<Button
											variant="ghost"
											size="sm"
											onclick={() =>
												(shownLines = {
													...shownLines,
													[file.path]: (shownLines[file.path] ?? PAGE_LINES) + PAGE_LINES * 5
												})}
										>
											Show more ({formatCount(file.lines.length - shown.length)} lines)
										</Button>
									</div>
								{:else if file.truncated}
									<p class="px-3 py-1.5 text-xs text-muted-foreground">
										The rest of this file's diff is too long to show.
									</p>
								{/if}
							{/if}
						{/if}
					</section>
				{/each}
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
