<script lang="ts" module>
	import type { CodingTaskDiff as TaskDiff } from '$lib/coding-diff.js';

	/** How long a read of the task's diff is reused, e.g. while clicking through a checkpoint's files. */
	const DIFF_TTL_MS = 15_000;
	// A plain cache, not reactive state: each viewer awaits the promise it gets.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const diffs = new Map<string, { at: number; diff: Promise<TaskDiff | null> }>();

	/** Forgets the task's cached diff, e.g. when a run just changed files. */
	export function forgetTaskDiff(conversationId: string): void {
		diffs.delete(conversationId);
	}

	/** The task's diff; it only marks changes, so a failure leaves the viewer working (null). */
	function taskDiff(conversationId: string, fresh = false): Promise<TaskDiff | null> {
		const cached = diffs.get(conversationId);
		if (cached && !fresh && Date.now() - cached.at < DIFF_TTL_MS) return cached.diff;
		const diff = fetch(`/api/coding/tasks/${encodeURIComponent(conversationId)}/diff`)
			.then((res) => (res.ok ? (res.json() as Promise<TaskDiff>) : null))
			.catch(() => null);
		const now = Date.now();
		for (const [id, entry] of diffs) if (now - entry.at >= DIFF_TTL_MS) diffs.delete(id);
		diffs.set(conversationId, { at: now, diff });
		// A failed read isn't kept, so the next open tries again.
		void diff.then((d) => {
			if (d === null && diffs.get(conversationId)?.diff === diff) diffs.delete(conversationId);
		});
		return diff;
	}
</script>

<script lang="ts">
	import { getContext, tick, untrack } from 'svelte';
	import { mode } from 'mode-watcher';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import FileXIcon from '@lucide/svelte/icons/file-x';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import {
		CODING_FILES_CONTEXT,
		fileLanguage,
		splitFilePath,
		type CodingFilesViewer,
		type CodingFileContents,
		type CodingFileRef
	} from '$lib/coding-file-links.js';
	import { resolve } from '$app/paths';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import {
		inlineDiff,
		newLineNumbers,
		findDiffFile,
		type CodingDiffFile
	} from '$lib/coding-diff.js';
	import { formatCount } from '$lib/formats.js';
	import { streamdownHighlighter } from '$lib/components/ai/markdown/code-highlight.js';
	import Markdown from '$lib/components/ai/markdown/markdown.svelte';
	import CodingDiffLines from './CodingDiffLines.svelte';

	/** A file the coding agent linked to, read from its machine, with its changes in this task. */
	let {
		conversationId,
		file: ref,
		open = $bindable(false)
	}: { conversationId: string; file: CodingFileRef | null; open?: boolean } = $props();

	/** Files longer than this aren't syntax highlighted (tokenizing them stalls the page). */
	const HIGHLIGHT_MAX_CHARS = 200_000;
	const HIGHLIGHT_MAX_LINES = 5_000;
	/**
	 * A one-line code block, rendered hidden only to create Streamdown's highlighter:
	 * its code block registers it on `window.STREAMDOWN_HIGHLIGHTER` (streamdown-svelte 3.x,
	 * see `streamdownHighlighter` in code-highlight.ts). If that ever stops, files show as plain text.
	 */
	const BOOT_BLOCK = '```text\n.\n```';

	type Token = { content: string; color?: string };

	let file = $state<CodingFileContents | null>(null);
	let diffFile = $state<CodingDiffFile | null>(null);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	/** The token can't read files: pairing the environment again fixes it. */
	let needsRepair = $state(false);
	let view = $state<'file' | 'changes'>('file');
	let tokens = $state<Token[][] | null>(null);
	let scroller = $state<HTMLElement | null>(null);
	let bootHighlighter = $state(false);
	let loadSeq = 0;
	/** The chat's viewer, for jumping to the task's whole diff when this file is gone. */
	const codingFiles = getContext<CodingFilesViewer | undefined>(CODING_FILES_CONTEXT);
	let loadAbort: AbortController | null = null;
	/** The File/Changes switch: the selected side stands out in both themes. */
	const SELECTED = 'text-foreground ring-1 ring-border';
	const UNSELECTED = 'text-muted-foreground';

	const name = $derived(ref ? splitFilePath(ref.path).name : '');
	const dir = $derived(file?.absolutePath ? splitFilePath(file.absolutePath).dir : '');
	const lines = $derived(file?.exists ? file.contents.replace(/\r?\n$/, '').split(/\r?\n/) : []);
	/** The task's changes laid over the file: added lines, and removed ones in place. */
	const inline = $derived(diffFile ? inlineDiff(diffFile) : null);
	const added = $derived(inline?.added ?? new Set<number>());
	const removedBefore = $derived(inline?.removedBefore ?? new Map<number, string[]>());
	const changeStarts = $derived(inline?.changeStarts ?? []);
	/** The change last jumped to (-1: none yet). */
	let changeIndex = $state(-1);
	/** The task's diff was read, so a file missing from it really has no changes. */
	let diffLoaded = $state(false);
	const target = $derived.by(() => {
		const start = ref?.line ?? null;
		if (!start) return null;
		return { start, end: Math.max(start, ref?.endLine ?? start) };
	});
	const lineLabel = $derived(
		target
			? target.end > target.start
				? `Lines ${target.start}–${target.end}`
				: `Line ${target.start}`
			: null
	);
	/** T3 refuses most binary files; this catches the ones it reads as text. */
	const binary = $derived(!!file?.exists && file.contents.includes('\0'));
	const pastEnd = $derived(!!target && !!file?.exists && !binary && target.start > lines.length);
	/** A deleted file's short diff fits without the full-height dialog. */
	const SHORT_DIFF_LINES = 30;
	/** Nothing (or little) to scroll through: the dialog shrinks to its content. */
	const compact = $derived(
		!!loadError ||
			(!!file && !diffFile && (!file.exists || binary)) ||
			(!!file && !file.exists && !!diffFile && diffFile.lines.length <= SHORT_DIFF_LINES)
	);
	/** The linked line, if the diff shows it (it's marked there too). */
	const linkedInDiff = $derived(
		!!target && !!diffFile && newLineNumbers(diffFile.lines).includes(target.start)
	);
	const showLegend = $derived(
		view === 'changes'
			? linkedInDiff
			: !!file?.exists &&
					!binary &&
					(added.size > 0 || removedBefore.size > 0 || (!!target && !pastEnd))
	);
	const noTaskChanges = $derived(
		diffLoaded && !diffFile && !!file?.exists && !binary && view === 'file'
	);
	const canStepChanges = $derived(
		view === 'file' && !!file?.exists && !binary && changeStarts.length > 1
	);
	/** Width of the line-number gutter, in characters. */
	const gutter = $derived(String(Math.max(lines.length, 1)).length);

	/** `fresh`: read the task's diff again too (Refresh), instead of a recent copy. */
	async function load(fresh = false) {
		if (!ref) return;
		const seq = ++loadSeq;
		loadAbort?.abort();
		const abort = (loadAbort = new AbortController());
		const path = ref.path;
		loading = true;
		loadError = null;
		needsRepair = false;
		tokens = null;
		const base = `/api/coding/tasks/${encodeURIComponent(conversationId)}`;
		// The diff only marks changed lines, so a failure there doesn't fail the viewer.
		const diffRequest = taskDiff(conversationId, fresh);
		try {
			const res = await fetch(`${base}/file?path=${encodeURIComponent(path)}`, {
				signal: abort.signal
			});
			const data = (await res.json().catch(() => null)) as
				(CodingFileContents & { message?: string }) | null;
			if (!res.ok || !data) {
				if (seq === loadSeq) needsRepair = res.status === 403;
				throw new Error(data?.message ?? 'Could not open the file');
			}
			const diff = await diffRequest;
			diffLoaded = diff !== null;
			if (seq !== loadSeq) return;
			file = data;
			diffFile = diff && data.workspacePath ? findDiffFile(diff, data.workspacePath) : null;
			if (!data.exists && diffFile) view = 'changes';
			void highlight(data, seq);
			await revealTarget();
		} catch (e) {
			if (seq !== loadSeq) return;
			file = null;
			diffFile = null;
			loadError = e instanceof Error ? e.message : 'Could not open the file';
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}

	/**
	 * Streamdown's shared highlighter (with the app's themes), which its first
	 * code block creates. With none on the page yet, a hidden one creates it.
	 */
	async function sharedHighlighter() {
		if (!streamdownHighlighter()) {
			bootHighlighter = true;
			await tick();
		}
		return streamdownHighlighter();
	}

	/** Colours the code like the chat's code blocks; plain text if that isn't possible. */
	async function highlight(data: CodingFileContents, seq: number) {
		const language = fileLanguage(name);
		if (!language || !data.exists || data.contents.length > HIGHLIGHT_MAX_CHARS) return;
		if (lines.length > HIGHLIGHT_MAX_LINES) return;
		const highlighter = await sharedHighlighter();
		if (!highlighter || seq !== loadSeq) return;
		const theme = mode.current === 'dark' ? 'github-dark-default' : 'github-light-default';
		try {
			if (!highlighter.isReady(theme, language)) await highlighter.load(theme, language);
			const result = highlighter.highlightCode(
				data.contents.replace(/\r?\n$/, ''),
				language,
				theme
			);
			if (seq === loadSeq && result.length === lines.length) tokens = result as Token[][];
		} catch {
			// Unknown language or theme: plain text is fine.
		}
	}

	/** Scrolls to a change in the file: its removed lines if it starts with some, else its first line. */
	async function goToChange(index: number) {
		if (!scroller || changeStarts.length === 0) return;
		changeIndex = (index + changeStarts.length) % changeStarts.length;
		await tick();
		const line = changeStarts[changeIndex];
		const row =
			scroller.querySelector(`[data-removed-before="${line}"]`) ??
			scroller.querySelector(`[data-line="${line}"]`);
		row?.scrollIntoView({ block: 'center' });
	}

	/**
	 * Scrolls to the linked line: in the file, or the nearest change at or after
	 * it in the diff. Without one, the file opens at its first change.
	 */
	async function revealTarget() {
		if (!scroller) return;
		if (!target) {
			if (view === 'file' && changeStarts.length > 0) await goToChange(0);
			return;
		}
		await tick();
		if (view === 'file') {
			// Past the end (the file changed since the link): show its end.
			const line = Math.min(target.start, lines.length);
			scroller.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
			return;
		}
		const rows = [...scroller.querySelectorAll<HTMLElement>('[data-new-line]')];
		const row = rows.find((r) => Number(r.dataset.newLine) >= target.start) ?? rows.at(-1);
		row?.scrollIntoView({ block: 'center' });
	}

	async function copyPath() {
		try {
			await navigator.clipboard.writeText(file?.absolutePath ?? ref?.path ?? '');
			toast.success('Path copied');
		} catch {
			toast.error('Failed to copy');
		}
	}

	$effect(() => {
		if (!open || !ref) return;
		// Reopening or following another link starts at the file itself.
		view = 'file';
		file = null;
		diffFile = null;
		changeIndex = -1;
		diffLoaded = false;
		void load();
	});

	// Theme switches re-colour the open file (`load` colours it the first time).
	let lastMode = mode.current;
	$effect(() => {
		const current = mode.current;
		if (current === lastMode) return;
		lastMode = current;
		untrack(() => {
			if (file) void highlight(file, loadSeq);
		});
	});

	type LineState = 'both' | 'target' | 'added' | 'plain';
	const inTarget = (n: number) => !!target && n >= target.start && n <= target.end;
	function lineState(n: number): LineState {
		if (inTarget(n)) return added.has(n) ? 'both' : 'target';
		return added.has(n) ? 'added' : 'plain';
	}
	const TARGET_GUTTER =
		'border-amber-500 bg-[color-mix(in_oklab,var(--color-amber-400)_24%,var(--background))] font-semibold text-foreground';
	const ROW_CLASS: Record<LineState, string> = {
		both: 'bg-amber-400/25 shadow-[inset_3px_0_0_var(--success)]',
		target: 'bg-amber-400/25',
		added: 'bg-success/10',
		plain: ''
	};
	const GUTTER_CLASS: Record<LineState, string> = {
		both: TARGET_GUTTER,
		target: TARGET_GUTTER,
		added: 'border-success bg-[color-mix(in_oklab,var(--success)_10%,var(--background))]',
		plain: 'bg-background'
	};
	/** Read by screen readers for the lines that stand out (line numbers are hidden from them). */
	const LINE_NOTE: Record<LineState, string> = {
		both: 'linked line, changed by this task',
		target: 'linked line',
		added: 'changed by this task',
		plain: ''
	};
</script>

<!-- Lines the task removed, shown where they were (before current line `before`). -->
{#snippet removed(before: number)}{#each removedBefore.get(before) ?? [] as text, r (r)}<div
			data-removed-before={r === 0 ? before : undefined}
			class="flex bg-destructive/10 [contain-intrinsic-size:auto_1.25rem] [content-visibility:auto]"
		>
			<span
				class="sticky left-0 w-(--gutter) shrink-0 border-r border-destructive bg-[color-mix(in_oklab,var(--destructive)_10%,var(--background))] pr-2 text-right text-destructive select-none"
				><span aria-hidden="true">−</span><span class="sr-only">Removed line</span></span
			><span class="pr-4 pl-3 text-foreground/70">{text}</span>
		</div>{/each}{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex {compact
			? 'h-auto'
			: 'h-[calc(100dvh-2rem)]'} max-h-[60rem] w-full max-w-[calc(100vw-2rem)] flex-col gap-3 p-4 sm:max-w-5xl"
		onkeydown={(event) => {
			// n / p step through the changes, like in a code review.
			if (!canStepChanges || event.metaKey || event.ctrlKey || event.altKey) return;
			if ((event.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
			if (event.key === 'n' || event.key === 'p') {
				event.preventDefault();
				void goToChange(
					event.key === 'n' ? changeIndex + 1 : changeIndex <= 0 ? -1 : changeIndex - 1
				);
			}
		}}
		onOpenAutoFocus={(event) => {
			// Start on the code (arrow keys scroll it), not on the first header button.
			event.preventDefault();
			scroller?.focus({ preventScroll: true });
		}}
	>
		<Dialog.Header class="min-w-0 pr-10">
			<div class="flex min-w-0 items-center gap-2">
				<Dialog.Title class="flex min-w-0 items-center gap-2">
					<FileCodeIcon class="size-4 shrink-0" />
					<span class="truncate font-mono text-sm" title={file?.absolutePath ?? ref?.path}
						>{name}</span
					>
					{#if file && !file.exists}
						<span
							class="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive"
							>Deleted</span
						>
					{/if}
					{#if lineLabel && view === 'file'}
						<span
							class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground/80"
							>{lineLabel}</span
						>
					{/if}
				</Dialog.Title>
				<div class="ml-auto flex shrink-0 items-center">
					<Button
						variant="ghost"
						size="icon-sm"
						class="text-muted-foreground"
						title="Copy path"
						aria-label="Copy the file's path"
						onclick={() => void copyPath()}
					>
						<CopyIcon />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						class="text-muted-foreground"
						title="Refresh"
						aria-label="Reload the file"
						disabled={loading || !!loadError}
						onclick={() => void load(true)}
					>
						<RotateCwIcon class={loading ? 'animate-spin' : ''} />
					</Button>
				</div>
			</div>
			<!-- Cut from the start, so the folders nearest the file stay visible. -->
			<Dialog.Description
				class="truncate text-left font-mono text-xs [direction:rtl]"
				title={file?.absolutePath ?? ref?.path}
			>
				<bdi>{dir || (ref ? splitFilePath(ref.path).dir : '') || 'File on the coding machine'}</bdi>
			</Dialog.Description>
		</Dialog.Header>

		{#if diffFile || showLegend || canStepChanges || noTaskChanges}
			<div class="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
				{#if diffFile}
					<div class="flex gap-1" role="group" aria-label="Show">
						<Button
							variant={view === 'file' ? 'secondary' : 'ghost'}
							class={view === 'file' ? SELECTED : UNSELECTED}
							size="sm"
							aria-pressed={view === 'file'}
							disabled={!file?.exists}
							title={file?.exists ? undefined : 'The file no longer exists'}
							onclick={() => {
								view = 'file';
								void revealTarget();
							}}
						>
							File
						</Button>
						<Button
							variant={view === 'changes' ? 'secondary' : 'ghost'}
							class={view === 'changes' ? SELECTED : UNSELECTED}
							size="sm"
							aria-pressed={view === 'changes'}
							onclick={() => {
								view = 'changes';
								void revealTarget();
							}}
						>
							Changes
							<span class="font-mono text-xs tabular-nums">
								<span class="text-success-foreground">+{formatCount(diffFile.additions)}</span>
								<span class="text-destructive">−{formatCount(diffFile.deletions)}</span>
							</span>
						</Button>
					</div>
				{/if}
				{#if showLegend}
					<p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						{#if target && (view === 'changes' || !pastEnd)}
							<span class="flex items-center gap-1.5"
								><span
									class="inline-block size-2.5 rounded-sm border border-amber-500 bg-amber-400/25"
									aria-hidden="true"
								></span>Linked {target.end > target.start ? 'lines' : 'line'}</span
							>
						{/if}
						{#if removedBefore.size > 0 && view === 'file'}
							<span class="flex items-center gap-1.5"
								><span
									class="inline-block size-2.5 rounded-sm border border-destructive bg-destructive/10"
									aria-hidden="true"
								></span>Removed</span
							>
						{/if}
						{#if added.size > 0 && view === 'file'}
							<span class="flex items-center gap-1.5"
								><span
									class="inline-block size-2.5 rounded-sm border border-success bg-success/10"
									aria-hidden="true"
								></span>Added or changed</span
							>
						{/if}
					</p>
				{/if}
				{#if noTaskChanges}
					<p class="text-xs text-muted-foreground">
						{ref?.fromCheckpoint
							? 'Changed in this checkpoint, but not in the task’s current diff (it may have been committed or reverted since).'
							: 'Not in the task’s current diff.'}
					</p>
				{/if}
				{#if view === 'file' && !!file?.exists && !binary && changeStarts.length === 1}
					<p class="ml-auto text-xs text-muted-foreground">1 change</p>
				{/if}
				{#if canStepChanges}
					<div class="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
						<kbd
							class="mr-1 rounded border bg-muted px-1 font-sans text-[10px] text-muted-foreground max-sm:hidden"
							title="Press N or P to step through the changes">N / P</kbd
						>
						<span class="tabular-nums" aria-live="polite">
							{changeIndex >= 0
								? `Change ${changeIndex + 1} of ${changeStarts.length}`
								: `${changeStarts.length} ${changeStarts.length === 1 ? 'change' : 'changes'}`}
						</span>
						<Button
							variant="ghost"
							size="icon-sm"
							title="Previous change (P)"
							aria-keyshortcuts="p"
							aria-label="Previous change"
							onclick={() => void goToChange(changeIndex <= 0 ? -1 : changeIndex - 1)}
						>
							<ChevronUpIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							title="Next change (N)"
							aria-keyshortcuts="n"
							aria-label="Next change"
							onclick={() => void goToChange(changeIndex + 1)}
						>
							<ChevronDownIcon />
						</Button>
					</div>
				{/if}
			</div>
		{/if}

		<!-- svelte-ignore a11y_no_noninteractive_tabindex (focusable so the keyboard can scroll the code) -->
		<div
			bind:this={scroller}
			tabindex="0"
			role="region"
			aria-label={view === 'changes' ? `Changes to ${name}` : `Contents of ${name}`}
			class="min-h-0 flex-1 overflow-auto rounded-md border focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:outline-none"
		>
			{#if loading && !file}
				<div class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
					<LoaderCircleIcon class="size-4 animate-spin" /> Opening file…
				</div>
			{:else if loadError}
				<div
					class="flex min-h-48 flex-col items-center justify-center gap-1.5 p-6 text-center text-sm"
				>
					<CircleAlertIcon class="mb-1 size-6 text-destructive" aria-hidden="true" />
					<p class="font-medium text-foreground">Couldn't open this file</p>
					<p class="max-w-md text-muted-foreground">{loadError}</p>
					<div class="mt-2 flex flex-wrap justify-center gap-2">
						{#if needsRepair}
							<Button size="sm" href={resolve('/settings/environments')}>
								Open coding environments
							</Button>
						{/if}
						<Button variant="outline" size="sm" onclick={() => void load(true)}>Try again</Button>
					</div>
				</div>
			{:else if file && view === 'changes' && diffFile}
				{#if !file.exists}
					<p class="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
						This file no longer exists, so only its changes are shown.
					</p>
				{/if}
				{#if diffFile.lines.length === 0}
					<p class="p-3 text-xs text-muted-foreground">
						{diffFile.binary
							? 'Binary file'
							: diffFile.truncated
								? file.exists
									? 'Left out of this large diff. Switch to File to read it.'
									: 'Left out of this large diff.'
								: 'No line changes.'}
					</p>
				{:else}
					<CodingDiffLines lines={diffFile.lines} highlight={target?.start ?? null} />
					{#if diffFile.truncated}
						<p class="px-3 py-1.5 text-xs text-muted-foreground">
							The rest of this file's diff is too long to show.
						</p>
					{/if}
				{/if}
			{:else if file && !file.exists}
				<div
					class="flex min-h-48 flex-col items-center justify-center gap-1.5 p-6 text-center text-sm"
				>
					<FileXIcon class="mb-1 size-6 text-muted-foreground" aria-hidden="true" />
					<p class="font-medium text-foreground">This file no longer exists</p>
					<p class="max-w-md text-muted-foreground">
						It may have been moved or deleted on the coding machine since the agent linked it.
					</p>
					{#if codingFiles?.openChanges}
						<Button
							variant="outline"
							size="sm"
							class="mt-2"
							onclick={() => {
								open = false;
								codingFiles.openChanges?.();
							}}
						>
							Review all changes
						</Button>
					{/if}
				</div>
			{:else if file && binary}
				<div
					class="flex min-h-48 flex-col items-center justify-center gap-1.5 p-6 text-center text-sm"
				>
					<FileXIcon class="mb-1 size-6 text-muted-foreground" aria-hidden="true" />
					<p class="font-medium text-foreground">Binary file</p>
					<p class="max-w-md text-muted-foreground">
						This file isn't text, so it can't be shown here.
					</p>
				</div>
			{:else if file}
				{#if file.truncated}
					<p class="sticky left-0 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
						Only the first part of this {formatCount(Math.round(file.byteLength / 1024))} KB file is shown.
					</p>
				{/if}
				{#if pastEnd && target}
					<p class="sticky left-0 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
						Line {formatCount(target.start)} is past the end of this {formatCount(
							lines.length
						)}-line file; it may have changed since the agent linked it.
					</p>
				{/if}
				{#if file.contents.length === 0}
					<p class="p-3 text-xs text-muted-foreground">This file is empty.</p>
				{:else}
					<pre
						class="min-w-max py-1 font-mono text-xs leading-5 [tab-size:4]"
						style:--gutter="{gutter + 2}ch">{#each lines as text, i (i)}{@const n =
								i + 1}{@const state = lineState(n)}{#if removedBefore.has(n)}{@render removed(
									n
								)}{/if}<div
								data-line={n}
								aria-current={n === target?.start ? 'location' : undefined}
								class="flex [contain-intrinsic-size:auto_1.25rem] [content-visibility:auto] {ROW_CLASS[
									state
								]}"><span
									class="sticky left-0 w-(--gutter) shrink-0 border-r pr-2 text-right text-muted-foreground tabular-nums select-none {GUTTER_CLASS[
										state
									]}"
									><span aria-hidden="true">{n}</span>{#if LINE_NOTE[state]}<span class="sr-only"
											>Line {n}, {LINE_NOTE[state]}</span
										>{/if}</span
								><span class="pr-4 pl-3"
									>{#if tokens?.[i]}{#each tokens[i] as token, t (t)}<span style:color={token.color}
												>{token.content}</span
											>{/each}{:else}{text}{/if}</span
								></div>{/each}{#if removedBefore.has(lines.length + 1)}{@render removed(
								lines.length + 1
							)}{/if}</pre>
				{/if}
			{/if}
		</div>
		{#if bootHighlighter}
			<div class="hidden" aria-hidden="true">
				<Markdown content={BOOT_BLOCK} streaming={false} />
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
