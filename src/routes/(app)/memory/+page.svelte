<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { SvelteSet } from 'svelte/reactivity';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import MemoryAuditEntry from '$lib/components/app/MemoryAuditEntry.svelte';
	import type {
		Concept,
		MemoryScope,
		MemorySearchHit,
		MemoryTreeNode,
		MemoryWriteEntry
	} from '$lib/memory-types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isAdmin = $derived(data.user.role === 'admin');

	let scope = $state<MemoryScope>('user');
	// Initial tree comes from the load function; afterwards it is refetched client-side.
	let tree = $state<MemoryTreeNode[]>(untrack(() => data.tree));
	let treeLoading = $state(false);

	let query = $state('');
	let searchResults = $state<MemorySearchHit[] | null>(null);
	let searchBusy = $state(false);

	const expanded = new SvelteSet<string>();

	function collectDirs(nodes: MemoryTreeNode[], depth: number, out: string[]) {
		for (const node of nodes) {
			if (node.kind !== 'dir') continue;
			if (depth === 0) out.push(node.path);
			collectDirs(node.children ?? [], depth + 1, out);
		}
	}

	function applyTree(nodes: MemoryTreeNode[]) {
		tree = nodes;
		const defaults: string[] = [];
		collectDirs(nodes, 0, defaults);
		for (const path of defaults) expanded.add(path);
	}

	untrack(() => applyTree(data.tree));

	async function refreshTree() {
		treeLoading = true;
		try {
			const res = await fetch(`/api/memory/tree?scope=${scope}`);
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			applyTree(((await res.json()) as { tree: MemoryTreeNode[] }).tree);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to load memory tree');
		} finally {
			treeLoading = false;
		}
	}

	function setScope(next: MemoryScope) {
		if (scope === next) return;
		scope = next;
		clearSelection();
		searchResults = null;
		query = '';
		expanded.clear();
		refreshTree();
	}

	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	function onSearchInput() {
		clearTimeout(searchTimer);
		const q = query.trim();
		if (!q) {
			searchResults = null;
			return;
		}
		searchTimer = setTimeout(() => runSearch(q), 300);
	}

	async function runSearch(q: string) {
		searchBusy = true;
		try {
			const res = await fetch(`/api/memory/search?q=${encodeURIComponent(q)}`);
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			searchResults = ((await res.json()) as { results: MemorySearchHit[] }).results;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Search failed');
		} finally {
			searchBusy = false;
		}
	}

	function selectSearchHit(hit: MemorySearchHit) {
		const hitScope: MemoryScope = hit.scope === 'shared' ? 'shared' : 'user';
		searchResults = null;
		query = '';
		if (hitScope !== scope) {
			scope = hitScope;
			clearSelection();
			expanded.clear();
			refreshTree();
		}
		selectConcept(hit.path);
	}

	type EditorState = {
		mode: 'none' | 'edit' | 'new';
		savedPath: string;
		path: string;
		type: string;
		title: string;
		description: string;
		tags: string;
		body: string;
		timestamp: string;
	};

	const emptyEditor: EditorState = {
		mode: 'none',
		savedPath: '',
		path: '',
		type: '',
		title: '',
		description: '',
		tags: '',
		body: '',
		timestamp: ''
	};

	let editor = $state<EditorState>({ ...emptyEditor });
	let editorLoading = $state(false);
	let saveBusy = $state(false);
	let deleteOpen = $state(false);
	let deleteBusy = $state(false);
	let extractBusy = $state(false);

	let writes = $state<MemoryWriteEntry[]>([]);
	let writesLoading = $state(false);
	let restoreBusy = $state(false);

	function editorFromConcept(concept: Concept): EditorState {
		return {
			mode: 'edit',
			savedPath: concept.path,
			path: concept.path,
			type: concept.frontmatter.type,
			title: concept.frontmatter.title,
			description: concept.frontmatter.description,
			tags: concept.frontmatter.tags.join(', '),
			body: concept.body,
			timestamp: concept.frontmatter.timestamp
		};
	}

	async function selectConcept(path: string) {
		editorLoading = true;
		try {
			const res = await fetch(
				`/api/memory/concept?scope=${scope}&path=${encodeURIComponent(path)}`
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? `Request failed (${res.status})`);
			}
			const { concept } = (await res.json()) as { concept: Concept };
			editor = editorFromConcept(concept);
			loadWrites(concept.path);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to load concept');
		} finally {
			editorLoading = false;
		}
	}

	function clearSelection() {
		editor = { ...emptyEditor };
		writes = [];
	}

	function startNew() {
		editor = { ...emptyEditor, mode: 'new' };
		writes = [];
	}

	async function loadWrites(path: string) {
		writesLoading = true;
		try {
			// Audit rows store shared concepts under a `shared/` path prefix.
			const auditPath = scope === 'shared' ? `shared/${path}` : path;
			const res = await fetch(
				`/api/memory/writes?scope=${scope}&path=${encodeURIComponent(auditPath)}&limit=50`
			);
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			writes = ((await res.json()) as { writes: MemoryWriteEntry[] }).writes;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to load history');
		} finally {
			writesLoading = false;
		}
	}

	function parseTags(raw: string): string[] {
		return raw
			.split(',')
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
	}

	async function putConcept(payload: Record<string, unknown>): Promise<Concept> {
		const res = await fetch('/api/memory/concept', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		const body = (await res.json().catch(() => null)) as {
			concept?: Concept;
			message?: string;
		} | null;
		if (!res.ok || !body?.concept) {
			throw new Error(body?.message ?? `Request failed (${res.status})`);
		}
		return body.concept;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (saveBusy) return;
		saveBusy = true;
		try {
			const frontmatter = {
				title: editor.title.trim(),
				...(editor.type.trim() ? { type: editor.type.trim() } : {}),
				description: editor.description.trim(),
				tags: parseTags(editor.tags)
			};
			const targetPath = editor.path.trim();
			let currentPath = editor.mode === 'edit' ? editor.savedPath : targetPath;
			// A PUT with newPath is a pure move (content is ignored), so a rename
			// combined with edits requires moving first and saving content after.
			if (editor.mode === 'edit' && targetPath !== editor.savedPath) {
				await putConcept({
					scope,
					path: editor.savedPath,
					newPath: targetPath,
					frontmatter,
					body: ''
				});
				currentPath = targetPath;
			}
			const concept = await putConcept({
				scope,
				path: currentPath,
				frontmatter,
				body: editor.body
			});
			toast.success('Saved');
			editor = editorFromConcept(concept);
			await refreshTree();
			await loadWrites(concept.path);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save concept');
		} finally {
			saveBusy = false;
		}
	}

	async function confirmDelete() {
		if (deleteBusy || editor.mode !== 'edit') return;
		deleteBusy = true;
		try {
			const res = await fetch(
				`/api/memory/concept?scope=${scope}&path=${encodeURIComponent(editor.savedPath)}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? `Request failed (${res.status})`);
			}
			toast.success('Concept deleted');
			deleteOpen = false;
			clearSelection();
			await refreshTree();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete concept');
		} finally {
			deleteBusy = false;
		}
	}

	async function restore(writeId: string) {
		if (restoreBusy || editor.mode !== 'edit') return;
		restoreBusy = true;
		try {
			const res = await fetch('/api/memory/restore', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scope, path: editor.savedPath, writeId })
			});
			const body = (await res.json().catch(() => null)) as {
				concept?: Concept;
				message?: string;
			} | null;
			if (!res.ok || !body?.concept) {
				throw new Error(body?.message ?? `Request failed (${res.status})`);
			}
			toast.success('Restored');
			const concept = body.concept;
			editor = editorFromConcept(concept);
			await refreshTree();
			await loadWrites(concept.path);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to restore');
		} finally {
			restoreBusy = false;
		}
	}

	async function extractNow() {
		if (extractBusy) return;
		extractBusy = true;
		try {
			const res = await fetch('/api/memory/extract', { method: 'POST' });
			const body = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
			toast.success('Extraction started');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to start extraction');
		} finally {
			extractBusy = false;
		}
	}
</script>

{#snippet treeNodes(nodes: MemoryTreeNode[], depth: number)}
	{#each nodes as node (node.path)}
		{#if node.kind === 'dir'}
			<div>
				<button
					type="button"
					class="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent/50"
					aria-expanded={expanded.has(node.path)}
					onclick={() => {
						if (expanded.has(node.path)) expanded.delete(node.path);
						else expanded.add(node.path);
					}}
				>
					{#if expanded.has(node.path)}
						<ChevronDownIcon class="size-3.5 shrink-0 text-muted-foreground" />
					{:else}
						<ChevronRightIcon class="size-3.5 shrink-0 text-muted-foreground" />
					{/if}
					<FolderIcon class="size-3.5 shrink-0 text-muted-foreground" />
					<span class="truncate">{node.name}</span>
				</button>
				{#if expanded.has(node.path) && node.children}
					<div class="ml-[13px] border-l border-border pl-2">
						{@render treeNodes(node.children, depth + 1)}
					</div>
				{/if}
			</div>
		{:else}
			<button
				type="button"
				class="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-sm {editor.mode ===
					'edit' && editor.savedPath === node.path
					? 'bg-accent text-accent-foreground'
					: 'hover:bg-accent/50'}"
				onclick={() => selectConcept(node.path)}
			>
				<FileTextIcon class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
				<span class="min-w-0 flex-1">
					<span class="block truncate">{node.title || node.name.replace(/\.md$/, '')}</span>
					{#if node.description}
						<span class="block truncate text-xs text-muted-foreground" title={node.description}>
							{node.description}
						</span>
					{/if}
				</span>
			</button>
		{/if}
	{/each}
{/snippet}

<div class="h-full [scrollbar-gutter:stable] overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl gap-8 p-6">
		<nav class="sticky top-6 flex w-56 shrink-0 flex-col gap-1 self-start">
			<h1 class="mb-2 flex items-center gap-2 px-3 text-lg font-semibold">
				<BrainIcon class="size-5" />
				Memory
			</h1>
			{#if isAdmin}
				<div class="mb-1 flex rounded-md border p-0.5">
					<button
						type="button"
						class="flex-1 rounded-sm px-2 py-1 text-xs {scope === 'user'
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:bg-accent/50'}"
						onclick={() => setScope('user')}
					>
						My memory
					</button>
					<button
						type="button"
						class="flex-1 rounded-sm px-2 py-1 text-xs {scope === 'shared'
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:bg-accent/50'}"
						onclick={() => setScope('shared')}
					>
						Shared
					</button>
				</div>
			{/if}
			<div class="mb-1 px-0">
				<Input
					placeholder="Search memory…"
					bind:value={query}
					oninput={onSearchInput}
					class="h-8 text-sm"
				/>
			</div>
			<div class="mb-2 flex gap-2 px-0">
				<Button variant="outline" size="sm" class="flex-1" onclick={startNew}>
					<PlusIcon class="size-3.5" />
					New
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="flex-1"
					disabled={extractBusy}
					onclick={extractNow}
				>
					{#if extractBusy}
						<LoaderCircleIcon class="size-3.5 animate-spin" />
					{:else}
						<ZapIcon class="size-3.5" />
					{/if}
					Extract
				</Button>
			</div>

			{#if searchResults !== null}
				{#if searchBusy}
					<p class="px-3 pt-2 text-sm text-muted-foreground">Searching…</p>
				{:else}
					{#each searchResults as hit (`${hit.scope}:${hit.path}`)}
						<button
							type="button"
							class="flex w-full flex-col gap-0.5 rounded-md px-3 py-1.5 text-left hover:bg-accent/50"
							onclick={() => selectSearchHit(hit)}
						>
							<span class="flex items-center gap-1.5 text-sm">
								<span class="truncate font-medium">{hit.title || hit.path}</span>
								{#if hit.scope === 'shared'}
									<Badge variant="secondary" class="shrink-0">shared</Badge>
								{/if}
							</span>
							<span class="truncate text-xs text-muted-foreground">{hit.path}</span>
							<!-- Snippet HTML is generated server-side from the caller's own memory files
							     (SQLite FTS snippet() only injects <mark> tags around matched terms), so
							     rendering it raw is safe here. -->
							<!-- eslint-disable svelte/no-at-html-tags -->
							<span class="line-clamp-2 text-xs text-muted-foreground [&_mark]:bg-yellow-500/30">
								{@html hit.snippet}
							</span>
							<!-- eslint-enable svelte/no-at-html-tags -->
						</button>
					{:else}
						<p class="px-3 pt-2 text-sm text-muted-foreground">No matches.</p>
					{/each}
				{/if}
			{:else if treeLoading && tree.length === 0}
				<p class="px-3 pt-2 text-sm text-muted-foreground">Loading…</p>
			{:else}
				{@render treeNodes(tree, 0)}
				{#if tree.length === 0}
					<p class="px-3 pt-2 text-sm text-muted-foreground">No concepts yet.</p>
				{/if}
			{/if}
		</nav>

		<main class="min-w-0 flex-1">
			{#if editor.mode === 'none'}
				<div class="flex h-96 items-center justify-center">
					<div class="flex flex-col items-center gap-2 text-muted-foreground">
						<BrainIcon class="size-8" />
						<p class="text-sm">Select a concept or create a new one</p>
					</div>
				</div>
			{:else if editorLoading}
				<div class="flex h-96 items-center justify-center">
					<LoaderCircleIcon class="size-5 animate-spin text-muted-foreground" />
				</div>
			{:else}
				<form onsubmit={save} class="flex w-full flex-col gap-4">
					<div class="flex items-center justify-between gap-2">
						<Badge variant="secondary">{scope === 'shared' ? 'Shared' : 'My memory'}</Badge>
						{#if editor.mode === 'edit' && editor.timestamp}
							<span class="text-xs text-muted-foreground" title={editor.timestamp}>
								Updated {new Date(editor.timestamp).toLocaleString()}
							</span>
						{/if}
					</div>

					<div class="flex flex-col gap-2">
						<Label for="mem-path">Path</Label>
						<Input
							id="mem-path"
							bind:value={editor.path}
							required
							placeholder="topics/foo.md"
							class="font-mono text-sm"
						/>
						{#if editor.mode === 'edit'}
							<p class="text-xs text-muted-foreground">Changing the path renames the concept.</p>
						{/if}
					</div>

					<div class="grid grid-cols-2 gap-4">
						<div class="flex flex-col gap-2">
							<Label for="mem-title">Title</Label>
							<Input id="mem-title" bind:value={editor.title} required maxlength={200} />
						</div>
						<div class="flex flex-col gap-2">
							<Label for="mem-type">Type</Label>
							<Input id="mem-type" bind:value={editor.type} placeholder="concept" maxlength={50} />
						</div>
					</div>

					<div class="flex flex-col gap-2">
						<Label for="mem-description">Description</Label>
						<Input id="mem-description" bind:value={editor.description} maxlength={500} />
					</div>

					<div class="flex flex-col gap-2">
						<Label for="mem-tags">Tags (comma-separated)</Label>
						<Input id="mem-tags" bind:value={editor.tags} placeholder="people, family" />
					</div>

					<div class="flex flex-col gap-2">
						<Label for="mem-body">Body</Label>
						<Textarea id="mem-body" bind:value={editor.body} class="min-h-[40vh] font-mono text-sm" />
					</div>

					<div class="flex gap-2">
						<Button type="submit" disabled={saveBusy}>
							{saveBusy ? 'Saving…' : editor.mode === 'new' ? 'Create' : 'Save'}
						</Button>
						{#if editor.mode === 'edit'}
							<Button variant="destructive" onclick={() => (deleteOpen = true)}>Delete</Button>
						{:else}
							<Button variant="outline" onclick={clearSelection}>Cancel</Button>
						{/if}
					</div>
				</form>

				{#if editor.mode === 'edit'}
					<section class="mt-10 w-full">
						<h2 class="mb-3 text-sm font-semibold">History</h2>
						<div class="flex flex-col gap-2">
							{#if writesLoading}
								<div class="flex justify-center pt-4">
									<LoaderCircleIcon class="size-4 animate-spin text-muted-foreground" />
								</div>
							{:else}
								{#each writes as entry (entry.id)}
									<MemoryAuditEntry {entry} {restoreBusy} onrestore={restore} />
								{:else}
									<p class="text-sm text-muted-foreground">No writes recorded yet.</p>
								{/each}
							{/if}
						</div>
					</section>
				{/if}
			{/if}
		</main>
	</div>
</div>

<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete concept?</Dialog.Title>
			<Dialog.Description>
				"{editor.title || editor.path}" will be permanently deleted. This is recorded in the write
				history.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteBusy} onclick={confirmDelete}>
				{deleteBusy ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
