<script lang="ts">
	import type { Component } from 'svelte';
	import { cn } from '$lib/utils.js';

	// A text input with an app-styled suggestion list (instead of a native <datalist>,
	// which renders as an unstyled OS popup). Typing stays free-form.
	let {
		value,
		oninput,
		suggestions = [],
		id,
		placeholder,
		icon: Icon,
		class: className,
		inputClass,
		...rest
	}: {
		value: string;
		oninput: (value: string) => void;
		suggestions?: string[];
		id?: string;
		placeholder?: string;
		icon?: Component<{ class?: string }>;
		class?: string;
		inputClass?: string;
		'aria-label'?: string;
		'aria-describedby'?: string;
		required?: boolean;
		maxlength?: number;
	} = $props();

	const uid = $props.id();
	const listId = `${uid}-list`;
	let open = $state(false);
	// -1: nothing highlighted, so Enter keeps what was typed.
	let active = $state(-1);

	const matches = $derived.by(() => {
		const q = value.trim().toLowerCase();
		return suggestions
			.filter((s) => s.toLowerCase() !== q && (!q || s.toLowerCase().includes(q)))
			.sort(
				(a, b) =>
					Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) ||
					a.localeCompare(b)
			)
			.slice(0, 6);
	});
	const showList = $derived(open && matches.length > 0);

	function pick(s: string) {
		oninput(s);
		open = false;
		active = -1;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (!matches.length) return;
			e.preventDefault();
			open = true;
			const n = matches.length;
			active = e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1;
		} else if (e.key === 'Enter' && showList && active >= 0) {
			e.preventDefault();
			pick(matches[active]);
		} else if (e.key === 'Escape' && showList) {
			e.preventDefault();
			e.stopPropagation();
			open = false;
			active = -1;
		}
	}
</script>

<div class={cn('relative min-w-0', className)}>
	{#if Icon}
		<Icon
			class="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
		/>
	{/if}
	<input
		{...rest}
		{id}
		{value}
		{placeholder}
		autocomplete="off"
		role="combobox"
		aria-expanded={showList}
		aria-controls={showList ? listId : undefined}
		aria-autocomplete="list"
		aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
		class={cn(
			// Same tokens as the app's Input, so the form's fields read as one set.
			'h-9 w-full min-w-0 rounded-3xl border border-transparent bg-input/50 px-3 text-base transition-[color,box-shadow,background-color] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 md:text-sm pointer-coarse:h-10',
			Icon && 'pl-8.5',
			inputClass
		)}
		oninput={(e) => {
			oninput(e.currentTarget.value);
			open = true;
			active = -1;
		}}
		onfocus={() => (open = true)}
		onblur={() => {
			open = false;
			active = -1;
		}}
		{onkeydown}
	/>
	{#if showList}
		<ul
			id={listId}
			role="listbox"
			class="absolute top-full left-0 z-30 mt-1 w-full min-w-40 overflow-hidden rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md"
		>
			{#each matches as match, i (match)}
				<li
					id="{listId}-{i}"
					role="option"
					aria-selected={i === active}
					class="cursor-pointer truncate rounded-md px-2 py-1 {i === active
						? 'bg-accent text-accent-foreground'
						: ''}"
					onpointerdown={(e) => {
						e.preventDefault();
						pick(match);
					}}
					onpointerenter={() => (active = i)}
				>
					{match}
				</li>
			{/each}
		</ul>
	{/if}
</div>
