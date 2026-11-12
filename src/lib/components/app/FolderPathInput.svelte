<script lang="ts" module>
	export interface FolderEntry {
		name: string;
		path: string;
	}

	/** Last segment of a path (`~/code/app/` → `app`), or '' for `~` and roots. */
	export function folderName(path: string): string {
		const segment =
			path
				.replace(/[\\/]+$/, '')
				.split(/[\\/]/)
				.pop() ?? '';
		return segment === '~' || /^[a-z]:$/i.test(segment) ? '' : segment;
	}

	/** Separator the environment uses, judged from a path it returned. */
	const separatorOf = (path: string) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');
</script>

<script lang="ts">
	import FolderIcon from '@lucide/svelte/icons/folder';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Input } from '$lib/components/ui/input/index.js';

	let {
		id,
		value = $bindable(''),
		environmentId,
		disabled = false,
		active = true
	}: {
		id: string;
		value?: string;
		environmentId: string;
		disabled?: boolean;
		/** Suggestions are only fetched while the field is in use. */
		active?: boolean;
	} = $props();

	const DEBOUNCE_MS = 150;
	const listboxId = $derived(`${id}-folders`);

	let entries = $state<FolderEntry[]>([]);
	let loading = $state(false);
	let focused = $state(false);
	let dismissed = $state(false);
	let highlighted = $state(-1);

	const showList = $derived(focused && !dismissed && entries.length > 0);

	// Suggest folders for whatever is typed. Debounced; an older response never
	// replaces a newer one because its request is aborted first.
	$effect(() => {
		const partialPath = value.trim();
		if (!active || !partialPath) {
			entries = [];
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			loading = true;
			try {
				const params = new URLSearchParams({ environmentId, path: partialPath });
				const res = await fetch(`/api/coding/folders?${params}`, { signal: controller.signal });
				const body = (await res.json().catch(() => null)) as { entries?: FolderEntry[] } | null;
				entries = res.ok ? (body?.entries ?? []) : [];
				highlighted = -1;
			} catch {
				if (!controller.signal.aborted) entries = [];
			} finally {
				if (!controller.signal.aborted) loading = false;
			}
		}, DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	/** Fills in a folder and moves on to listing its subfolders. */
	function choose(entry: FolderEntry) {
		value = entry.path + separatorOf(entry.path);
		dismissed = false;
		highlighted = -1;
	}

	function onkeydown(e: KeyboardEvent) {
		if (!showList) {
			if (e.key === 'ArrowDown' && entries.length > 0) {
				dismissed = false;
				e.preventDefault();
			}
			return;
		}
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				highlighted = (highlighted + 1) % entries.length;
				break;
			case 'ArrowUp':
				e.preventDefault();
				highlighted = highlighted <= 0 ? entries.length - 1 : highlighted - 1;
				break;
			case 'Enter':
				// Without a highlighted folder, Enter submits the form as usual.
				if (highlighted >= 0) {
					e.preventDefault();
					choose(entries[highlighted]);
				}
				break;
			case 'Tab':
				// Shell-style completion: Tab takes the highlighted (or only/first) folder.
				if (!e.shiftKey) {
					e.preventDefault();
					choose(entries[Math.max(highlighted, 0)]);
				}
				break;
			case 'Escape':
				// Close the list, not the dialog.
				e.preventDefault();
				e.stopPropagation();
				dismissed = true;
				break;
		}
	}
</script>

<div class="relative">
	<Input
		{id}
		bind:value
		placeholder="~/projects/my-app"
		autocomplete="off"
		spellcheck={false}
		{disabled}
		role="combobox"
		aria-autocomplete="list"
		aria-expanded={showList}
		aria-controls={listboxId}
		aria-activedescendant={showList && highlighted >= 0 ? `${listboxId}-${highlighted}` : undefined}
		class="pr-9 font-mono"
		oninput={() => (dismissed = false)}
		onfocus={() => (focused = true)}
		onblur={() => (focused = false)}
		{onkeydown}
	/>
	{#if loading}
		<LoaderCircleIcon
			class="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
			aria-hidden="true"
		/>
	{/if}
	{#if showList}
		<!-- Over the content below rather than in the flow, so the dialog doesn't grow. -->
		<ul
			id={listboxId}
			role="listbox"
			aria-label="Folders"
			class="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-2xl border bg-popover p-1 text-popover-foreground shadow-md"
		>
			{#each entries as entry, i (entry.path)}
				<li
					id="{listboxId}-{i}"
					role="option"
					aria-selected={i === highlighted}
					class={[
						'flex cursor-default items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm',
						i === highlighted && 'bg-accent text-accent-foreground'
					]}
					onpointerenter={() => (highlighted = i)}
					onpointerdown={(e) => {
						// Keep focus in the field so typing can continue.
						e.preventDefault();
						choose(entry);
					}}
				>
					<FolderIcon class="size-4 shrink-0 text-muted-foreground" />
					<span class="truncate">{entry.name}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
