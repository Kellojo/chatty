<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { cn } from '$lib/utils.js';

	let {
		tags,
		onchange,
		suggestions = [],
		id,
		placeholder = 'Add a tag',
		class: className
	}: {
		tags: string[];
		onchange: (tags: string[]) => void;
		/** Existing tags offered while typing. */
		suggestions?: string[];
		id?: string;
		placeholder?: string;
		class?: string;
	} = $props();

	let draft = $state('');
	let input = $state<HTMLInputElement | null>(null);
	// -1: nothing highlighted, so Enter adds exactly what was typed.
	let active = $state(-1);
	let open = $state(false);
	// The last tag is marked for removal by a first Backspace.
	let armed = $state(false);
	const uid = $props.id();
	const listId = `${uid}-suggestions`;

	const normalize = (t: string) => t.trim().replace(/^#/, '').trim();

	const matches = $derived.by(() => {
		const q = normalize(draft).toLowerCase();
		const taken = new Set(tags.map((t) => t.toLowerCase()));
		return suggestions
			.filter((s) => !taken.has(s.toLowerCase()) && (!q || s.toLowerCase().includes(q)))
			.sort(
				(a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q))
			)
			.slice(0, 6);
	});
	// What's typed, offered as a new tag unless it already exists.
	const fresh = $derived.by(() => {
		const tag = normalize(draft);
		const lower = tag.toLowerCase();
		if (!tag || tags.some((t) => t.toLowerCase() === lower)) return null;
		return suggestions.some((s) => s.toLowerCase() === lower) ? null : tag;
	});
	type Option = { value: string; label: string };
	const options = $derived<Option[]>([
		...matches.map((m) => ({ value: m, label: m })),
		...(fresh ? [{ value: fresh, label: `Add “${fresh}”` }] : [])
	]);
	// Opens on focus too, so existing tags (most used first) are easy to reuse.
	const showList = $derived(open && options.length > 0);

	function add(raw: string) {
		const next = [...tags];
		for (const part of raw.split(',')) {
			const tag = normalize(part);
			if (tag && !next.some((t) => t.toLowerCase() === tag.toLowerCase())) next.push(tag);
		}
		if (next.length !== tags.length) onchange(next);
		draft = '';
		active = -1;
	}

	function remove(index: number) {
		onchange(tags.filter((_, i) => i !== index));
		input?.focus();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (showList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
			e.preventDefault();
			const n = options.length;
			active = e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1;
		} else if ((e.key === 'Enter' || e.key === 'Tab') && showList && active >= 0 && !e.shiftKey) {
			// A highlighted option wins, even with nothing typed.
			e.preventDefault();
			add(options[active].value);
		} else if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && draft.trim())) {
			if (!draft.trim()) return;
			e.preventDefault();
			add(draft);
		} else if (e.key === 'Backspace' && !draft && tags.length) {
			// First press marks the last tag, the second removes it.
			e.preventDefault();
			if (armed) {
				onchange(tags.slice(0, -1));
				armed = false;
			} else armed = true;
		} else if (e.key === 'Escape' && showList) {
			e.preventDefault();
			e.stopPropagation();
			open = false;
			active = -1;
		}
	}
</script>

<div class="relative">
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		class={cn(
			// Same tokens as the app's Input.
			'flex min-h-9 w-full cursor-text flex-wrap items-center gap-1 rounded-[1.125rem] border border-transparent bg-input/50 px-1.5 py-1.5 text-base transition-[color,box-shadow,background-color] has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/30 md:text-sm pointer-coarse:min-h-10',
			className
		)}
		onclick={() => input?.focus()}
	>
		{#each tags as tag, i (tag)}
			<span
				data-armed={armed && i === tags.length - 1 ? '' : undefined}
				class="inline-flex h-6 items-center gap-0.5 rounded-full bg-background pr-0.5 pl-2.5 text-xs font-medium text-foreground shadow-xs data-armed:ring-2 data-armed:ring-ring/60 dark:bg-secondary"
			>
				{tag}
				<button
					type="button"
					class="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:p-1.5"
					aria-label="Remove tag {tag}"
					onclick={(e) => {
						e.stopPropagation();
						remove(i);
					}}
				>
					<XIcon class="size-3" />
				</button>
			</span>
		{/each}
		<input
			bind:this={input}
			bind:value={draft}
			{id}
			placeholder={tags.length ? '' : placeholder}
			autocomplete="off"
			role="combobox"
			aria-expanded={showList}
			aria-controls={showList ? listId : undefined}
			aria-autocomplete="list"
			aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
			class="h-6 min-w-20 flex-1 bg-transparent px-1.5 outline-none placeholder:text-muted-foreground"
			oninput={() => {
				armed = false;
				open = true;
				active = -1;
			}}
			onfocus={() => (open = true)}
			onblur={() => {
				armed = false;
				open = false;
				if (draft.trim()) add(draft);
			}}
			{onkeydown}
		/>
	</div>
	{#if showList}
		<ul
			id={listId}
			role="listbox"
			class="absolute top-full left-0 z-30 mt-1 w-full max-w-72 min-w-48 overflow-hidden rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md"
		>
			{#each options as option, i (option.label)}
				<li
					id="{listId}-{i}"
					role="option"
					aria-selected={i === active}
					class="cursor-pointer truncate rounded-md px-2 py-1 {i === active
						? 'bg-accent text-accent-foreground'
						: ''} flex items-center gap-1.5"
					onpointerdown={(e) => {
						e.preventDefault();
						add(option.value);
					}}
					onpointerenter={() => (active = i)}
				>
					{#if option.label !== option.value}<PlusIcon
							class="size-3.5 shrink-0 text-muted-foreground"
						/>{/if}<span class="truncate">{option.label}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
