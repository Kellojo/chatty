<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { SvelteSet } from 'svelte/reactivity';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import { guardUnsavedChanges, isSaveShortcut, missingHint } from '$lib/form-guards.js';
	import MemoryAuditEntry from '$lib/components/app/MemoryAuditEntry.svelte';
	import MemoryGraphView from '$lib/components/app/MemoryGraph.svelte';
	import MemoryView, { type MemoryConnection } from '$lib/components/app/MemoryView.svelte';
	import MemoryEditForm from '$lib/components/app/MemoryEditForm.svelte';
	import type {
		Concept,
		MemoryGraph,
		MemoryGraphNode,
		MemoryScope,
		MemorySearchHit,
		MemoryTreeNode,
		MemoryWriteEntry
	} from '$lib/memory-types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isAdmin = $derived(data.user.role === 'admin');
	const tabs = $derived<{ value: MemoryScope | 'map'; label: string }[]>([
		{ value: 'user', label: 'My memory' },
		...(isAdmin ? [{ value: 'shared' as const, label: 'Shared' }] : []),
		{ value: 'map', label: 'Map' }
	]);

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

	function countFiles(nodes: MemoryTreeNode[]): number {
		let count = 0;
		for (const node of nodes) count += node.kind === 'dir' ? countFiles(node.children ?? []) : 1;
		return count;
	}

	function applyTree(nodes: MemoryTreeNode[]) {
		tree = nodes;
		const defaults: string[] = [];
		collectDirs(nodes, 0, defaults);
		for (const path of defaults) expanded.add(path);
	}

	untrack(() => applyTree(data.tree));

	// The map tab shows every memory you can open: your own, plus shared ones for admins.
	// It also feeds the "Connected memories" list, so it loads up front.
	let view = $state<'browse' | 'map'>('browse');
	let graph = $state.raw<MemoryGraph | null>(null);
	// Bumped per request so a slow response can't overwrite a newer one.
	let graphToken = 0;
	let graphFailed = $state(false);

	async function refreshGraph() {
		const token = ++graphToken;
		try {
			const res = await fetch('/api/memory/graph');
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			const next = (await res.json()) as MemoryGraph;
			if (token === graphToken) {
				graph = next;
				graphFailed = false;
			}
		} catch {
			// The list still works without the map.
			if (token === graphToken) graphFailed = true;
		}
	}

	/** Opens a memory from the map or a connection, switching scope when needed. */
	function openNode(node: Pick<MemoryGraphNode, 'scope' | 'path'>) {
		if (!canLeaveEditor()) return;
		view = 'browse';
		if (node.scope !== scope) {
			scope = node.scope;
			searchResults = null;
			query = '';
			expanded.clear();
			void refreshTree();
		}
		void selectConcept(node.path);
	}

	function collectPaths(nodes: MemoryTreeNode[], out: Set<string>): Set<string> {
		for (const node of nodes) {
			if (node.kind === 'dir') collectPaths(node.children ?? [], out);
			else out.add(node.path);
		}
		return out;
	}
	// Rebuilt whenever the tree changes.
	const knownPaths = $derived(collectPaths(tree, new Set()));

	// What the edit form suggests, from memories in the open scope.
	const scopeNodes = $derived(graph ? graph.nodes.filter((n) => n.scope === scope) : []);
	// Most-used tags first, so the tag field offers the likeliest ones on focus.
	const tagSuggestions = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local tally inside a derived
		const counts = new Map<string, number>();
		for (const tag of scopeNodes.flatMap((n) => n.tags))
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
	});
	const typeSuggestions = $derived(
		[...new Set(scopeNodes.map((n) => n.type).filter(Boolean))].sort((a, b) => a.localeCompare(b))
	);
	const folders = $derived(
		[
			...new Set(
				[...knownPaths].filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/')))
			)
		].sort((a, b) => a.localeCompare(b))
	);
	const linkTargets = $derived(
		scopeNodes
			.filter((n) => n.path !== editor.savedPath)
			.map((n) => ({ title: n.title, path: n.path, hint: n.path.replace(/\.md$/, '') }))
	);

	$effect(() => {
		untrack(() => void refreshGraph());
	});

	async function refreshTree() {
		void refreshGraph();
		treeLoading = true;
		try {
			const res = await fetch(`/api/memory/tree?scope=${scope}`);
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			applyTree(((await res.json()) as { tree: MemoryTreeNode[] }).tree);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to load memories');
		} finally {
			treeLoading = false;
		}
	}

	function setTab(next: MemoryScope | 'map') {
		if (next === 'map') {
			view = 'map';
			return;
		}
		if (view === 'map' && scope === next) {
			view = 'browse';
			return;
		}
		view = 'browse';
		setScope(next);
	}

	function setScope(next: MemoryScope) {
		if (scope === next || !canLeaveEditor()) return;
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
		if (!canLeaveEditor()) return;
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
	// An open memory is shown rendered; `editing` swaps in the form. New memories start there.
	let editing = $state(false);

	const openId = $derived(editor.mode === 'edit' ? `${scope}:${editor.savedPath}` : null);

	// Memories linked to or sharing a tag with the open one, links first.
	const connections = $derived.by((): MemoryConnection[] => {
		if (!graph || !openId) return [];
		const byId = new Map(graph.nodes.map((n) => [n.id, n]));
		const out: MemoryConnection[] = [];
		for (const kind of ['link', 'tag'] as const) {
			for (const e of graph.edges) {
				if (e.kind !== kind || (e.source !== openId && e.target !== openId)) continue;
				const other = byId.get(e.source === openId ? e.target : e.source);
				if (other) out.push({ ...other, kind });
			}
		}
		return out;
	});
	let saveBusy = $state(false);
	// The editor as last loaded or saved, to tell unsaved edits apart.
	let baseline = $state<EditorState>({ ...emptyEditor });
	let editorLoading = $state(false);
	const dirty = $derived(
		editor.mode !== 'none' &&
			(['path', 'type', 'title', 'description', 'tags', 'body'] as const).some(
				(key) => editor[key] !== baseline[key]
			)
	);
	// New memories get a path from their title until the path is edited by hand.
	let pathEdited = $state(false);
	$effect(() => {
		if (editor.mode !== 'new' || pathEdited) return;
		const slug = editor.title
			.toLowerCase()
			.replace(/['’]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 80);
		const folder = editor.path.includes('/')
			? editor.path.slice(0, editor.path.lastIndexOf('/') + 1)
			: '';
		editor.path = slug ? `${folder}${slug}.md` : folder;
	});

	function setEditor(next: EditorState) {
		editor = next;
		baseline = { ...next };
		pathEdited = false;
		editing = next.mode === 'new';
	}

	function startEditing() {
		if (editor.mode !== 'edit') return;
		editing = true;
		// Land in the content, where most edits happen.
		requestAnimationFrame(() => document.getElementById('mem-body')?.focus());
	}

	/** Leaves the form: back to the rendered memory, or out of a new one. */
	function stopEditing() {
		if (!canLeaveEditor()) return;
		if (editor.mode === 'new') clearSelection();
		else {
			editor = { ...baseline };
			editing = false;
		}
	}

	/** Asks before throwing away unsaved edits; true when it's fine to move on. */
	function canLeaveEditor(): boolean {
		return !dirty || confirm('Discard your unsaved changes to this memory?');
	}

	const missing = $derived(
		missingHint(
			[
				!editor.title.trim() && 'a title',
				// The path follows the title, so it only goes missing once edited away.
				!!editor.title.trim() && !editor.path.trim() && 'a path'
			],
			editor.mode === 'new' ? 'create' : 'save'
		)
	);
	const canSave = $derived(!saveBusy && !missing && (editor.mode === 'new' || dirty));
	let formEl = $state<HTMLFormElement | null>(null);

	guardUnsavedChanges(() => dirty);

	function isTyping(target: EventTarget | null): boolean {
		return (
			target instanceof HTMLElement &&
			(target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
		);
	}

	function onKeydown(event: KeyboardEvent) {
		if (editor.mode === 'none' || deleteOpen || view !== 'browse') return;
		// E edits the open memory, like most note apps.
		if (
			!editing &&
			event.key.toLowerCase() === 'e' &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!isTyping(event.target)
		) {
			event.preventDefault();
			startEditing();
			return;
		}
		if (editing && event.key === 'Escape' && !event.defaultPrevented) {
			event.preventDefault();
			stopEditing();
			return;
		}
		if (!editing || !isSaveShortcut(event)) return;
		event.preventDefault();
		if (canSave) formEl?.requestSubmit();
	}

	// Nothing to browse: no list pane at all, and one first-run panel until a memory is opened.
	const treeEmpty = $derived(tree.length === 0 && !treeLoading && !query.trim());
	const firstRun = $derived(treeEmpty && editor.mode === 'none');
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

	// Bumped per selection so a slow response can't overwrite a newer pick.
	let selectToken = 0;

	async function selectConcept(path: string) {
		const token = ++selectToken;
		editorLoading = true;
		try {
			// Load the memory and its history together and swap both in at once, so the
			// open editor stays in place instead of collapsing to a spinner and back.
			const [conceptRes, history] = await Promise.all([
				fetch(`/api/memory/concept?scope=${scope}&path=${encodeURIComponent(path)}`),
				fetchWrites(path).catch((e: unknown) => {
					toast.error(e instanceof Error ? e.message : 'Failed to load history');
					return [];
				})
			]);
			if (!conceptRes.ok) {
				const body = (await conceptRes.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? `Request failed (${conceptRes.status})`);
			}
			const { concept } = (await conceptRes.json()) as { concept: Concept };
			if (token !== selectToken) return;
			setEditor(editorFromConcept(concept));
			writes = history;
		} catch (e) {
			if (token === selectToken) {
				toast.error(e instanceof Error ? e.message : 'Failed to load memory');
			}
		} finally {
			if (token === selectToken) editorLoading = false;
		}
	}

	function clearSelection() {
		selectToken++;
		editorLoading = false;
		setEditor({ ...emptyEditor });
		writes = [];
	}

	function startNew() {
		if (!canLeaveEditor()) return;
		view = 'browse';
		selectToken++;
		editorLoading = false;
		setEditor({ ...emptyEditor, mode: 'new' });
		writes = [];
	}

	async function fetchWrites(path: string): Promise<MemoryWriteEntry[]> {
		// Audit rows store shared concepts under a `shared/` path prefix.
		const auditPath = scope === 'shared' ? `shared/${path}` : path;
		const res = await fetch(
			`/api/memory/writes?scope=${scope}&path=${encodeURIComponent(auditPath)}&limit=50`
		);
		if (!res.ok) throw new Error(`Request failed (${res.status})`);
		return ((await res.json()) as { writes: MemoryWriteEntry[] }).writes;
	}

	async function loadWrites(path: string) {
		writesLoading = true;
		try {
			writes = await fetchWrites(path);
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
			setEditor(editorFromConcept(concept));
			await refreshTree();
			await loadWrites(concept.path);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save memory');
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
			toast.success('Memory deleted');
			deleteOpen = false;
			clearSelection();
			await refreshTree();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete memory');
		} finally {
			deleteBusy = false;
		}
	}

	async function restore(writeId: string) {
		if (restoreBusy || editor.mode !== 'edit') return;
		const question = dirty
			? 'Restore this version? It replaces the saved memory and discards your unsaved changes.'
			: 'Restore this version? It replaces the saved memory; the current version stays in the history.';
		if (!confirm(question)) return;
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
			setEditor(editorFromConcept(concept));
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
			toast.success('Extracting memories from recent chats');
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
			<li>
				<button
					type="button"
					class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
					aria-expanded={expanded.has(node.path)}
					onclick={() => {
						if (expanded.has(node.path)) expanded.delete(node.path);
						else expanded.add(node.path);
					}}
				>
					<ChevronRightIcon
						class="size-3.5 shrink-0 transition-transform {expanded.has(node.path)
							? 'rotate-90'
							: ''}"
					/>
					<FolderIcon class="size-4 shrink-0" />
					<span class="truncate font-medium">{node.name}</span>
					<span class="ml-auto text-xs tabular-nums">{countFiles(node.children ?? [])}</span>
				</button>
				{#if expanded.has(node.path) && node.children}
					<ul class="ml-[15px] border-l border-border/60 pl-1.5">
						{@render treeNodes(node.children, depth + 1)}
					</ul>
				{/if}
			</li>
		{:else}
			{@const selected = editor.mode === 'edit' && editor.savedPath === node.path}
			<li>
				<button
					type="button"
					aria-current={selected ? 'true' : undefined}
					class="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors {selected
						? 'bg-accent text-accent-foreground'
						: 'hover:bg-accent/50'}"
					onclick={() => {
						if (canLeaveEditor()) void selectConcept(node.path);
					}}
				>
					<span class="truncate text-sm {selected ? 'font-medium' : ''}"
						>{node.title || node.name.replace(/\.md$/, '')}</span
					>
					{#if node.description}
						<span class="line-clamp-1 text-xs text-muted-foreground" title={node.description}>
							{node.description}
						</span>
					{/if}
				</button>
			</li>
		{/if}
	{/each}
{/snippet}

<svelte:head><title>Memory · Chatty</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 *:max-w-4xl md:p-6">
		<PageHeader
			title="Memory"
			icon={BrainIcon}
			description="What Chatty remembers across chats. The AI keeps these up to date, and you can edit them too."
		>
			{#snippet actions()}
				{#if !firstRun}
					<Button
						variant="outline"
						disabled={extractBusy}
						onclick={extractNow}
						title="Distill recent chats into memories now"
					>
						{#if extractBusy}
							<LoaderCircleIcon class="size-4 animate-spin" />
						{:else}
							<ZapIcon class="size-4" />
						{/if}
						Extract from chats
					</Button>
					{#if editor.mode !== 'new'}
						<Button onclick={startNew}><PlusIcon class="size-4" />New memory</Button>
					{/if}
				{/if}
			{/snippet}
		</PageHeader>

		<div
			class="-mx-4 -mb-2 flex gap-1 border-b px-4 md:mx-0 md:px-0"
			role="group"
			aria-label="Memory view"
		>
			{#each tabs as tab (tab.value)}
				{@const active =
					tab.value === 'map' ? view === 'map' : view === 'browse' && scope === tab.value}
				<button
					type="button"
					aria-pressed={active}
					class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors md:py-2 {active
						? 'border-foreground font-medium text-foreground'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => setTab(tab.value)}
				>
					{#if tab.value === 'map'}<NetworkIcon class="size-3.5" />{/if}
					{tab.label}
				</button>
			{/each}
		</div>

		{#if view === 'map'}
			<!-- Wider than the page's reading width: the map earns the space. -->
			<section
				class="relative h-[calc(100dvh-15rem)] min-h-[28rem] max-w-none! overflow-hidden rounded-2xl border bg-card"
				aria-label="Memory map"
			>
				<div class="absolute inset-x-4 top-3 z-10 flex items-center gap-2">
					<h2 class="shrink-0 text-sm font-medium whitespace-nowrap">Memory map</h2>
					{#if graph}
						<p class="hidden truncate text-xs text-muted-foreground sm:block">
							{graph.nodes.length}
							{graph.nodes.length === 1 ? 'memory' : 'memories'} · click to open, drag to explore
						</p>
					{/if}
				</div>
				{#if graph && graph.nodes.length > 0}
					<MemoryGraphView {graph} selected={openId} insetTop={44} onselect={openNode} />
				{:else if graph || graphFailed}
					<div class="flex size-full items-center justify-center">
						<EmptyState
							icon={NetworkIcon}
							title={graphFailed ? 'Couldn’t load the map' : 'Nothing to map yet'}
							description={graphFailed
								? 'Something went wrong loading your memories. Try again in a moment.'
								: 'Memories show up here as they’re saved, connected by their links and tags.'}
						>
							{#if graphFailed}
								<Button size="sm" variant="outline" onclick={() => void refreshGraph()}
									>Retry</Button
								>
							{/if}
						</EmptyState>
					</div>
				{:else}
					<div class="flex size-full items-center justify-center" aria-busy="true">
						<LoaderCircleIcon class="size-5 animate-spin text-muted-foreground" />
					</div>
				{/if}
			</section>
		{:else if firstRun}
			<SettingsSection>
				<EmptyState
					icon={BrainIcon}
					title={scope === 'shared' ? 'No shared memories yet' : 'No memories yet'}
					description={scope === 'shared'
						? 'Shared memories are visible to everyone. Add one to get started.'
						: 'Chatty saves what it learns from your chats here, and uses it in later chats. Extract from your recent chats now, or add a memory yourself.'}
				>
					<Button size="sm" onclick={startNew}><PlusIcon class="size-4" />New memory</Button>
					{#if scope === 'user'}
						<Button size="sm" variant="outline" disabled={extractBusy} onclick={extractNow}>
							{#if extractBusy}
								<LoaderCircleIcon class="size-4 animate-spin" />
							{:else}
								<ZapIcon class="size-4" />
							{/if}
							Extract from chats
						</Button>
					{/if}
				</EmptyState>
			</SettingsSection>
		{:else}
			<div class="flex items-start gap-6">
				<!-- Phones show the list or the open memory, not both; editing gets the full width. -->
				<aside
					class="w-full flex-col gap-3 md:sticky md:top-6 md:w-72 md:shrink-0 {treeEmpty || editing
						? 'hidden'
						: editor.mode === 'none'
							? 'flex'
							: 'hidden md:flex'}"
					aria-label="Memories"
				>
					<div class="relative">
						<SearchIcon
							class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							type="search"
							placeholder="Search memory"
							aria-label="Search memory"
							class="pl-9"
							bind:value={query}
							oninput={onSearchInput}
						/>
					</div>

					<div
						class="rounded-2xl border bg-card p-1.5 md:max-h-[calc(100dvh-14rem)] md:overflow-y-auto"
					>
						{#if searchResults !== null || searchBusy}
							{#if searchBusy && searchResults === null}
								<p class="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
									<LoaderCircleIcon class="size-4 animate-spin" />Searching…
								</p>
							{:else if searchResults}
								<ul class="flex flex-col" aria-label="Search results">
									{#each searchResults as hit (`${hit.scope}:${hit.path}`)}
										<li>
											<button
												type="button"
												class="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent/50"
												onclick={() => selectSearchHit(hit)}
											>
												<span class="flex items-center gap-1.5 text-sm">
													<span class="truncate">{hit.title || hit.path}</span>
													{#if hit.scope === 'shared'}
														<Badge variant="secondary" class="shrink-0">Shared</Badge>
													{/if}
												</span>
												<!-- Safe to render raw: /api/memory/search calls searchMemoryFts with
											     { html: true }, which HTML-escapes the whole snippet first and only
											     then adds the <mark> highlight tags (concept text is often
											     model-written, so it must never reach the DOM unescaped). -->
												<!-- eslint-disable svelte/no-at-html-tags -->
												<span
													class="line-clamp-2 text-xs text-muted-foreground [&_mark]:rounded-sm [&_mark]:bg-yellow-500/30 [&_mark]:text-foreground"
												>
													{@html hit.snippet}
												</span>
												<!-- eslint-enable svelte/no-at-html-tags -->
											</button>
										</li>
									{:else}
										<li class="px-2 py-6 text-center text-sm text-muted-foreground">
											Nothing matches “{query.trim()}”.
										</li>
									{/each}
								</ul>
							{/if}
						{:else if treeLoading && tree.length === 0}
							<p class="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
								<LoaderCircleIcon class="size-4 animate-spin" />Loading…
							</p>
						{:else if tree.length === 0}
							<p class="px-2 py-6 text-center text-sm text-muted-foreground">No memories yet.</p>
						{:else}
							<ul class="flex flex-col" aria-label="Memories">
								{@render treeNodes(tree, 0)}
							</ul>
						{/if}
					</div>
				</aside>
				<main
					class="min-w-0 flex-1 flex-col gap-6 transition-opacity md:flex {editor.mode === 'none'
						? 'hidden'
						: 'flex'} {editorLoading && editor.mode !== 'none'
						? 'pointer-events-none opacity-60'
						: ''}"
					aria-busy={editorLoading}
				>
					{#if editor.mode === 'none'}
						<div
							class="flex min-h-80 flex-col items-center justify-center rounded-2xl border bg-card"
						>
							<EmptyState
								icon={FileTextIcon}
								title="Pick a memory"
								description="Choose one on the left to read or edit it, or add a new one."
							>
								<Button size="sm" variant="outline" onclick={startNew}>
									<PlusIcon class="size-4" />New memory
								</Button>
								<Button size="sm" variant="ghost" onclick={() => setTab('map')}>
									<NetworkIcon class="size-4" />Open the map
								</Button>
							</EmptyState>
						</div>
					{:else if !editing}
						<MemoryView
							path={editor.savedPath}
							{scope}
							title={editor.title}
							description={editor.description}
							type={editor.type}
							tags={parseTags(editor.tags)}
							body={editor.body}
							timestamp={editor.timestamp}
							{knownPaths}
							{connections}
							onback={clearSelection}
							onedit={startEditing}
							ondelete={() => (deleteOpen = true)}
							onshowmap={() => setTab('map')}
							onnavigate={(path) => openNode({ scope, path })}
							onopenconnection={openNode}
						/>

						<SettingsSection
							title="History"
							description="Every change to this memory, by you or the AI. Restore any earlier version."
						>
							{#if writesLoading && writes.length === 0}
								<div class="flex justify-center py-2">
									<LoaderCircleIcon class="size-4 animate-spin text-muted-foreground" />
								</div>
							{:else}
								<div class="flex flex-col gap-2">
									{#each writes as entry (entry.id)}
										<MemoryAuditEntry {entry} {restoreBusy} onrestore={restore} />
									{:else}
										<p class="text-sm text-muted-foreground">No changes recorded yet.</p>
									{/each}
								</div>
							{/if}
						</SettingsSection>
					{:else}
						<MemoryEditForm
							bind:draft={editor}
							savedPath={editor.savedPath}
							bind:form={formEl}
							mode={editor.mode === 'new' ? 'new' : 'edit'}
							{scope}
							{dirty}
							{missing}
							{canSave}
							{saveBusy}
							{tagSuggestions}
							{typeSuggestions}
							{folders}
							{linkTargets}
							onsubmit={save}
							oncancel={stopEditing}
							onfilenameedit={() => (pathEdited = true)}
						/>
					{/if}
				</main>
			</div>
		{/if}
	</div>
</div>

<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete memory?</Dialog.Title>
			<Dialog.Description>
				“{editor.title || editor.path}” will be deleted. The deletion is kept in the history log.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteBusy} onclick={confirmDelete}>
				{#if deleteBusy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
				Delete
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
