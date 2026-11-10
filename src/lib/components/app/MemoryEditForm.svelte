<script lang="ts" module>
	export type MemoryDraft = {
		path: string;
		type: string;
		title: string;
		description: string;
		/** Comma-separated, as stored in the page's editor state. */
		tags: string;
		body: string;
	};
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import MarkdownEditor, { type LinkTarget } from './MarkdownEditor.svelte';
	import TagInput from './TagInput.svelte';
	import SuggestInput from './SuggestInput.svelte';
	import { markMemoryLinksRelative } from '$lib/memory-links.js';

	let {
		draft = $bindable(),
		savedPath,
		mode,
		scope,
		dirty,
		missing,
		canSave,
		saveBusy,
		form = $bindable(null),
		tagSuggestions = [],
		typeSuggestions = [],
		folders = [],
		linkTargets = [],
		onsubmit,
		oncancel,
		onfilenameedit
	}: {
		draft: MemoryDraft;
		/** Where the memory lives now, to tell when an edit would move it. */
		savedPath: string;
		mode: 'new' | 'edit';
		scope: 'user' | 'shared';
		dirty: boolean;
		/** Why it can't be saved yet, e.g. "Add a title to create". */
		missing: string | null;
		canSave: boolean;
		saveBusy: boolean;
		form?: HTMLFormElement | null;
		tagSuggestions?: string[];
		typeSuggestions?: string[];
		/** Existing folders, offered for the path. */
		folders?: string[];
		linkTargets?: LinkTarget[];
		onsubmit: (event: SubmitEvent) => void;
		oncancel: () => void;
		/** The file name was typed by hand, so it stops following the title. */
		onfilenameedit: () => void;
	} = $props();

	const uid = $props.id();
	// An edit would move the file; only meaningful once there's a saved location.
	const moved = $derived(mode === 'edit' && !!savedPath && draft.path !== savedPath);
	let mod = $state('Ctrl');
	$effect(() => {
		if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) mod = '⌘';
	});

	const tags = $derived(
		draft.tags
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean)
	);
	// Phones only: the details card starts open for new memories, folded otherwise.
	let metaOpen = $state(untrack(() => mode === 'new'));
	const metaSummary = $derived(
		[tags.map((t) => `#${t}`).join(' '), draft.type, draft.path].filter(Boolean).join(' · ') ||
			'Tags, type and location'
	);
	const folder = $derived(
		draft.path.includes('/') ? draft.path.slice(0, draft.path.lastIndexOf('/')) : ''
	);
	const fileName = $derived(draft.path.slice(folder ? folder.length + 1 : 0));

	// Enter in a one-line field moves on instead of submitting; saving is Ctrl+S or the button.
	const nextField: Record<string, string> = {
		'mem-title': 'mem-description',
		'mem-description': 'mem-tags',
		'mem-tags': 'mem-type',
		'mem-type': 'mem-folder',
		'mem-folder': 'mem-file',
		'mem-file': 'mem-body'
	};
	function onFormKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented) return;
		const target = e.target as HTMLElement;
		if (target.tagName !== 'INPUT' && target.id !== 'mem-description') return;
		e.preventDefault();
		const next = nextField[target.id];
		if (next) document.getElementById(next)?.focus();
	}

	function setPath(nextFolder: string, nextFile: string) {
		const f = nextFolder.trim().replace(/^\/+|\/+$/g, '');
		draft.path = f ? `${f}/${nextFile}` : nextFile;
	}
</script>

<!-- Keyboard handling for the fields inside; the form itself is not a control. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form bind:this={form} {onsubmit} onkeydown={onFormKeydown} class="flex flex-col gap-5">
	<p class="text-xs text-muted-foreground">
		<span class="font-medium">{mode === 'new' ? 'New memory' : 'Editing'}</span> ·
		{scope === 'shared' ? 'Shared with everyone' : 'Private to you'}
	</p>

	<div class="flex flex-col gap-1">
		<Label for="mem-title" class="sr-only">Title</Label>
		<input
			id="mem-title"
			bind:value={draft.title}
			required
			maxlength={200}
			placeholder="Untitled memory"
			autocomplete="off"
			class="-mx-2 w-[calc(100%+1rem)] rounded-lg bg-transparent px-2 text-2xl font-semibold tracking-tight transition-colors outline-none placeholder:text-muted-foreground/70 hover:bg-muted/40 focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-ring/50"
		/>
		<Label for="mem-description" class="sr-only">Description</Label>
		<!-- Wraps instead of scrolling sideways, but stays one paragraph. -->
		<textarea
			id="mem-description"
			bind:value={draft.description}
			rows="1"
			maxlength={500}
			placeholder="Add a one-line summary"
			autocomplete="off"
			class="-mx-2 field-sizing-content w-[calc(100%+1rem)] resize-none rounded-lg bg-transparent px-2 text-base text-foreground/75 transition-colors outline-none placeholder:text-muted-foreground/60 hover:bg-muted/40 focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-ring/50"
		></textarea>
	</div>

	<!-- Labels sit beside the fields on wider screens. On phones the card folds into a
	     one-line summary so the note itself starts near the top. -->
	<div class="rounded-2xl border bg-card text-sm">
		<button
			type="button"
			class="flex w-full items-center gap-2 rounded-2xl px-4 py-3 text-left focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none sm:hidden"
			aria-expanded={metaOpen}
			aria-controls="{uid}-meta"
			onclick={() => (metaOpen = !metaOpen)}
		>
			<span class="shrink-0 font-medium">Details</span>
			<span class="min-w-0 flex-1 truncate text-muted-foreground">{metaSummary}</span>
			<ChevronDownIcon
				class="size-4 shrink-0 text-muted-foreground transition-transform {metaOpen
					? 'rotate-180'
					: ''}"
			/>
		</button>
		<div
			id="{uid}-meta"
			class="grid grid-cols-1 gap-x-3 gap-y-1.5 p-4 sm:grid-cols-[5.5rem_1fr] sm:items-center sm:gap-y-2.5 {metaOpen
				? 'max-sm:border-t'
				: 'max-sm:hidden'}"
		>
			<Label for="mem-tags" class="text-muted-foreground">Tags</Label>
			<TagInput
				id="mem-tags"
				{tags}
				suggestions={tagSuggestions}
				placeholder="Add tags to connect related memories"
				onchange={(next) => (draft.tags = next.join(', '))}
			/>

			<Label for="mem-type" class="mt-2 text-muted-foreground sm:mt-0">Type</Label>
			<SuggestInput
				id="mem-type"
				value={draft.type}
				oninput={(v) => (draft.type = v)}
				suggestions={typeSuggestions}
				placeholder="e.g. preference, person, project"
				maxlength={50}
			/>

			<Label for="mem-folder" class="mt-2 self-start text-muted-foreground sm:mt-0 sm:pt-2"
				>Location</Label
			>
			<div class="flex min-w-0 flex-col gap-1">
				<div class="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center">
					<SuggestInput
						id="mem-folder"
						value={folder}
						oninput={(v) => setPath(v, fileName)}
						suggestions={folders}
						icon={FolderIcon}
						placeholder="No folder"
						aria-label="Folder"
						class="sm:w-2/5"
					/>
					<span class="hidden text-muted-foreground sm:inline" aria-hidden="true">/</span>
					<Input
						value={fileName}
						oninput={(e) => {
							onfilenameedit();
							setPath(folder, e.currentTarget.value);
						}}
						required
						placeholder="file-name.md"
						id="mem-file"
						aria-label="File name"
						aria-describedby={mode === 'new' || moved ? `${uid}-path-hint` : undefined}
						autocomplete="off"
						class="min-w-0 flex-1 font-mono md:text-sm"
					/>
				</div>
				{#if mode === 'new'}
					<p id="{uid}-path-hint" class="text-xs text-muted-foreground">
						The file name follows the title until you change it.
					</p>
				{:else if moved}
					<p id="{uid}-path-hint" class="text-xs text-muted-foreground">
						Saving moves this memory from <span class="font-mono">{savedPath}</span>.
					</p>
				{/if}
			</div>
		</div>
	</div>

	<MarkdownEditor
		id="mem-body"
		bind:value={draft.body}
		placeholder="What should Chatty remember? Markdown works here."
		previewTransform={markMemoryLinksRelative}
		{linkTargets}
	/>

	<!-- Stays in view below the tall content field. -->
	<div
		class="sticky bottom-0 z-20 -mx-1 flex items-center gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur"
	>
		<p class="mr-auto flex min-w-0 items-center text-xs text-muted-foreground">
			<!-- Only the status is announced, not the static shortcut hint. -->
			<span class="flex items-center gap-2" aria-live="polite">
				{#if missing}
					{missing}
				{:else if dirty}
					<span class="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true"></span>
					Unsaved changes
				{/if}
			</span>
			<span class="hidden truncate md:inline">
				{#if missing || dirty}<span class="mx-1.5" aria-hidden="true">·</span>{/if}{mod}+S to save ·
				Esc to cancel
			</span>
		</p>
		<Button variant="ghost" onclick={oncancel}>Cancel</Button>
		<Button type="submit" disabled={!canSave} title="Save ({mod}+S)">
			{#if saveBusy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
			{mode === 'new' ? 'Create memory' : 'Save changes'}
		</Button>
	</div>
</form>
