<script lang="ts" module>
	export type LinkTarget = {
		title: string;
		/** Inserted as the link's URL. */
		path: string;
		/** Shown under the title, e.g. the folder. */
		hint?: string;
	};
</script>

<script lang="ts">
	import { onMount, tick, type Component } from 'svelte';
	import { cn } from '$lib/utils.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Markdown } from '$lib/components/ai/markdown/index.js';
	import {
		continueList,
		cycleHeading,
		indent,
		linkFromPaste,
		toggleLinePrefix,
		toggleLink,
		toggleWrap,
		type ListPrefix,
		type TextEdit
	} from '$lib/markdown-edit.js';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import HeadingIcon from '@lucide/svelte/icons/heading';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
	import ListTodoIcon from '@lucide/svelte/icons/list-todo';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import CodeIcon from '@lucide/svelte/icons/code';
	import LinkIcon from '@lucide/svelte/icons/link';
	import NoteLinkIcon from '@lucide/svelte/icons/file-text';
	import { caretCoordinates } from '$lib/textarea-caret.js';

	type Props = {
		value?: string;
		id?: string;
		placeholder?: string;
		class?: string;
		minHeight?: string;
		/** Adjusts the markdown before Preview renders it (the source is left untouched). */
		previewTransform?: (markdown: string) => string;
		/** Notes that `[[` can link to. Without them, `[[` is plain text. */
		linkTargets?: LinkTarget[];
	};

	let {
		value = $bindable(''),
		id,
		placeholder,
		class: className,
		minHeight = '40vh',
		previewTransform,
		linkTargets = []
	}: Props = $props();

	type Mode = 'write' | 'split' | 'preview';
	type Transform = (text: string, selStart: number, selEnd: number) => TextEdit | null;

	const MODE_KEY = 'chatty.markdownEditor.mode';
	// The last Write/Split choice sticks (Preview is a momentary check, so it doesn't).
	let mode = $state<Mode>('write');
	onMount(() => {
		try {
			if (localStorage.getItem(MODE_KEY) === 'split') mode = 'split';
		} catch {
			// Storage blocked: start in Write.
		}
	});
	$effect(() => {
		if (mode === 'preview') return;
		try {
			localStorage.setItem(MODE_KEY, mode);
		} catch {
			// Not remembered; fine.
		}
	});
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let mod = $state('Ctrl');
	let fieldSizing = $state(true);

	const uid = $props.id();
	const tabId = (m: Mode) => `${uid}-${m}-tab`;
	const panelId = `${uid}-panel`;
	const linkListId = `${uid}-links`;
	const modes: { key: Mode; label: string }[] = [
		{ key: 'write', label: 'Write' },
		{ key: 'split', label: 'Split' },
		{ key: 'preview', label: 'Preview' }
	];
	const showsSource = $derived(mode !== 'preview');

	// Split view re-renders markdown as you type; let it trail by a beat on long notes.
	let previewSource = $state('');
	$effect(() => {
		const next = value;
		if (mode !== 'split' || next.length < 4000) {
			previewSource = next;
			return;
		}
		const timer = setTimeout(() => (previewSource = next), 150);
		return () => clearTimeout(timer);
	});

	const words = $derived(value.trim() ? value.trim().split(/\s+/).length : 0);

	onMount(() => {
		if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) mod = '⌘';
		fieldSizing = CSS.supports('field-sizing', 'content');
	});

	// Auto-grow for browsers without `field-sizing: content`.
	$effect(() => {
		void value;
		if (fieldSizing || !textarea || !showsSource) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${textarea.scrollHeight + 2}px`;
	});

	/**
	 * Applies a transform to the textarea. Only the changed span is replaced,
	 * via `execCommand('insertText')` so native undo keeps working, with
	 * `setRangeText` as the fallback.
	 */
	function apply(transform: Transform): boolean {
		const ta = textarea;
		if (!ta) return false;
		const before = ta.value;
		const edit = transform(before, ta.selectionStart, ta.selectionEnd);
		if (!edit) return false;
		ta.focus();
		if (edit.text !== before) {
			const after = edit.text;
			let p = 0;
			const max = Math.min(before.length, after.length);
			while (p < max && before[p] === after[p]) p++;
			let s = 0;
			while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
			const inserted = after.slice(p, after.length - s);
			ta.setSelectionRange(p, before.length - s);
			let ok: boolean;
			try {
				ok = inserted
					? document.execCommand('insertText', false, inserted)
					: document.execCommand('delete');
			} catch {
				ok = false;
			}
			if (!ok) ta.setRangeText(inserted, p, before.length - s, 'end');
			if (ta.value !== after) ta.value = after;
			if (!ok) ta.dispatchEvent(new Event('input', { bubbles: true }));
			value = ta.value;
		}
		ta.setSelectionRange(edit.selStart, edit.selEnd);
		return true;
	}

	// `[[` opens a picker of notes to link; the typed text after it filters the list.
	type Picker = { start: number; query: string; top: number; left: number; above: boolean };
	const PICKER_HEIGHT = 300;
	let picker = $state<Picker | null>(null);
	let pickerActive = $state(0);

	const pickerMatches = $derived.by(() => {
		if (!picker) return [];
		const q = picker.query.trim().toLowerCase();
		return linkTargets
			.map((t) => {
				const title = t.title.toLowerCase();
				const rank = !q
					? 1
					: title.startsWith(q)
						? 0
						: title.includes(q)
							? 1
							: t.path.toLowerCase().includes(q)
								? 2
								: -1;
				return { t, rank };
			})
			.filter((m) => m.rank >= 0)
			.sort((a, b) => a.rank - b.rank || a.t.title.localeCompare(b.t.title))
			.slice(0, 8)
			.map((m) => m.t);
	});

	function updatePicker() {
		const ta = textarea;
		if (!ta || !linkTargets.length || ta.selectionStart !== ta.selectionEnd) {
			picker = null;
			return;
		}
		const caret = ta.selectionStart;
		const m = /\[\[([^[\]\n]{0,60})$/.exec(ta.value.slice(0, caret));
		if (!m) {
			picker = null;
			return;
		}
		const start = caret - m[0].length;
		const at = caretCoordinates(ta, start);
		if (!picker || picker.query !== m[1]) pickerActive = 0;
		// Open below the caret, or above it when there's no room left on screen
		// (the form's sticky footer covers the bottom ~70px).
		const caretTop = ta.offsetTop + at.top;
		// The visual viewport shrinks when a phone's keyboard opens; innerHeight doesn't.
		const vv = window.visualViewport;
		const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
		const roomBelow = viewportBottom - (ta.getBoundingClientRect().top + at.top + at.height);
		const above = roomBelow < PICKER_HEIGHT + 80;
		picker = {
			start,
			query: m[1],
			top: above ? caretTop - 4 : caretTop + at.height + 4,
			above,
			left: Math.min(ta.offsetLeft + at.left, Math.max(ta.offsetLeft + ta.clientWidth - 288, 8))
		};
	}

	function chooseLink(target: LinkTarget) {
		const p = picker;
		const ta = textarea;
		if (!p || !ta) return;
		const end = ta.selectionStart;
		const label = target.title.replace(/[[\]]/g, '');
		apply((text) => {
			const link = `[${label}](${target.path})`;
			return {
				text: text.slice(0, p.start) + link + text.slice(end),
				selStart: p.start + link.length,
				selEnd: p.start + link.length
			};
		});
		picker = null;
	}

	function plainLink() {
		const p = picker;
		const ta = textarea;
		if (!p || !ta) return;
		const end = ta.selectionStart;
		const label = p.query.trim();
		apply((text) => ({
			text: text.slice(0, p.start) + `[${label}]()` + text.slice(end),
			selStart: p.start + label.length + 3,
			selEnd: p.start + label.length + 3
		}));
		picker = null;
	}

	function onPaste(e: ClipboardEvent) {
		const pasted = e.clipboardData?.getData('text/plain') ?? '';
		const ta = textarea;
		if (!ta) return;
		const edit = linkFromPaste(ta.value, ta.selectionStart, ta.selectionEnd, pasted);
		if (!edit) return;
		e.preventDefault();
		apply(() => edit);
	}

	/** Toolbar entry point: types `[[` at the caret, which opens the picker. */
	function startLink() {
		apply((text, s, e) => ({
			text: text.slice(0, s) + '[[' + text.slice(e),
			selStart: s + 2,
			selEnd: s + 2
		}));
		updatePicker();
	}

	// Heading level of the caret's line, so the Heading button can say what it'll do.
	let headingLevel = $state(0);
	function trackCaret() {
		const ta = textarea;
		if (!ta) return;
		const lineStart = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
		headingLevel = /^(#{1,6}) /.exec(ta.value.slice(lineStart, lineStart + 7))?.[1].length ?? 0;
	}

	const wrap = (marker: string) => () => apply((t, s, e) => toggleWrap(t, s, e, marker));
	const prefix = (p: ListPrefix) => () => apply((t, s, e) => toggleLinePrefix(t, s, e, p));

	// Grouped inline · links · block (links early, so they stay visible on phones).
	type Tool = {
		key: string;
		group: 'inline' | 'block' | 'link';
		label: string;
		shortcut?: string;
		icon: Component;
		run: () => void;
	};
	const tools = $derived<Tool[]>([
		{
			key: 'bold',
			group: 'inline',
			label: 'Bold',
			shortcut: `${mod}+B`,
			icon: BoldIcon,
			run: wrap('**')
		},
		{
			key: 'italic',
			group: 'inline',
			label: 'Italic',
			shortcut: `${mod}+I`,
			icon: ItalicIcon,
			run: wrap('*')
		},
		{
			key: 'code',
			group: 'inline',
			label: 'Inline code',
			shortcut: `${mod}+E`,
			icon: CodeIcon,
			run: wrap('`')
		},
		{
			key: 'link',
			group: 'link',
			label: 'Link',
			shortcut: `${mod}+K`,
			icon: LinkIcon,
			run: () => apply(toggleLink)
		},
		...(linkTargets.length
			? [
					{
						key: 'note',
						group: 'link' as const,
						label: 'Link a note',
						shortcut: '[[',
						icon: NoteLinkIcon,
						run: startLink
					}
				]
			: []),
		{
			key: 'heading',
			group: 'block',
			label:
				headingLevel === 0
					? 'Heading'
					: headingLevel >= 3
						? `Heading (H${headingLevel} → text)`
						: `Heading (H${headingLevel} → H${headingLevel + 1})`,
			icon: HeadingIcon,
			run: () => {
				apply(cycleHeading);
				trackCaret();
			}
		},
		{ key: 'bullets', group: 'block', label: 'Bulleted list', icon: ListIcon, run: prefix('- ') },
		{
			key: 'numbers',
			group: 'block',
			label: 'Numbered list',
			icon: ListOrderedIcon,
			run: prefix('1. ')
		},
		{
			key: 'checklist',
			group: 'block',
			label: 'Checklist',
			icon: ListTodoIcon,
			run: prefix('- [ ] ')
		},
		{ key: 'quote', group: 'block', label: 'Quote', icon: QuoteIcon, run: prefix('> ') }
	]);

	function onkeydown(e: KeyboardEvent) {
		if (e.isComposing || e.altKey) return;
		if (e.key === 'Escape' && !picker) {
			// Leaves the field rather than the whole edit; a second Esc cancels.
			e.preventDefault();
			e.stopPropagation();
			textarea?.blur();
			return;
		}
		if (picker) {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				picker = null;
				return;
			}
			if (!pickerMatches.length && e.key === 'Enter' && picker.query.trim()) {
				// No note matches: keep the text as an ordinary link to fill in.
				e.preventDefault();
				plainLink();
				return;
			}
			if (pickerMatches.length) {
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					const n = pickerMatches.length;
					pickerActive = (pickerActive + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
					return;
				}
				if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
					e.preventDefault();
					chooseLink(pickerMatches[pickerActive]);
					return;
				}
			}
		}
		if (e.ctrlKey || e.metaKey) {
			const run = { b: wrap('**'), i: wrap('*'), e: wrap('`'), k: () => apply(toggleLink) }[
				e.key.toLowerCase()
			];
			if (run && !e.shiftKey) {
				e.preventDefault();
				run();
			}
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			if (apply(continueList)) e.preventDefault();
		} else if (e.key === 'Tab') {
			if (apply((t, s, end) => indent(t, s, end, e.shiftKey))) e.preventDefault();
		}
	}

	// The toolbar is one tab stop; arrow keys move between its buttons.
	let toolbar = $state<HTMLDivElement | null>(null);
	let toolIndex = $state(0);
	function onToolbarKeydown(e: KeyboardEvent) {
		const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
		let next: number | null = null;
		if (e.key in keys) next = (toolIndex + keys[e.key] + tools.length) % tools.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = tools.length - 1;
		if (next === null) return;
		e.preventDefault();
		toolIndex = next;
		toolbar?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
	}

	// Fade whichever edge of the toolbar has more buttons scrolled out of view.
	let toolbarFade = $state('');
	function measureToolbar() {
		const el = toolbar;
		if (!el) return;
		const left = el.scrollLeft > 2;
		const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
		toolbarFade =
			left && right
				? '[mask-image:linear-gradient(to_right,transparent,black_2.5rem,black_calc(100%-2.5rem),transparent)]'
				: right
					? '[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]'
					: left
						? '[mask-image:linear-gradient(to_right,transparent,black_2.5rem)]'
						: '';
	}
	$effect(() => {
		void rootWidth;
		void mode;
		measureToolbar();
	});

	async function setMode(next: Mode, focus = false) {
		mode = next;
		picker = null;
		if (!focus) return;
		await tick();
		document.getElementById(tabId(next))?.focus();
	}

	function onTabKeydown(e: KeyboardEvent) {
		const visible = modes.filter((m) => m.key !== 'split' || splitFits).map((m) => m.key);
		const i = visible.indexOf(mode);
		const next =
			e.key === 'Home'
				? visible[0]
				: e.key === 'End'
					? visible[visible.length - 1]
					: e.key === 'ArrowRight'
						? visible[(i + 1) % visible.length]
						: e.key === 'ArrowLeft'
							? visible[(i - 1 + visible.length) % visible.length]
							: null;
		if (!next) return;
		e.preventDefault();
		setMode(next, true);
	}

	// Split view needs room for two readable columns.
	let rootWidth = $state(0);
	const splitFits = $derived(rootWidth >= 720);
	$effect(() => {
		if (mode === 'split' && rootWidth && !splitFits) mode = 'write';
	});
</script>

<div
	bind:clientWidth={rootWidth}
	class={cn(
		'relative flex flex-col rounded-2xl border bg-card transition-[color,box-shadow,border-color] has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-ring/30',
		className
	)}
>
	<div class="flex min-w-0 items-center gap-2 border-b px-2 py-1.5">
		<div role="tablist" aria-label="Editor mode" class="flex shrink-0 rounded-lg bg-muted p-0.5">
			{#each modes.filter((m) => m.key !== 'split' || splitFits) as tab (tab.key)}
				{@const selected = mode === tab.key}
				<button
					type="button"
					role="tab"
					id={tabId(tab.key)}
					aria-selected={selected}
					aria-controls={panelId}
					tabindex={selected ? 0 : -1}
					class={cn(
						'h-7 rounded-md px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
						selected
							? 'bg-background text-foreground shadow-sm'
							: 'text-muted-foreground hover:text-foreground'
					)}
					onclick={() => setMode(tab.key)}
					onkeydown={onTabKeydown}
				>
					{tab.label}
				</button>
			{/each}
		</div>

		{#if showsSource}
			<div
				role="toolbar"
				tabindex="-1"
				aria-label="Formatting"
				aria-controls={id}
				bind:this={toolbar}
				onscroll={measureToolbar}
				onkeydown={onToolbarKeydown}
				class="-my-1 ml-auto flex min-w-0 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto py-1 max-sm:flex-1 {toolbarFade}"
			>
				{#each tools as tool, i (tool.key)}
					{@const title = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
					{#if i > 0 && tools[i - 1].group !== tool.group}
						<span class="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
					{/if}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						class="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-9"
						tabindex={i === toolIndex ? 0 : -1}
						{title}
						aria-label={title}
						onpointerdown={(e: PointerEvent) => e.preventDefault()}
						onfocus={() => (toolIndex = i)}
						onclick={tool.run}
					>
						<tool.icon class="size-4" />
					</Button>
				{/each}
			</div>
		{/if}
	</div>

	<div
		id={panelId}
		role="tabpanel"
		aria-labelledby={tabId(mode)}
		class="relative grid min-w-0 {mode === 'split' ? 'grid-cols-2' : 'grid-cols-1'}"
	>
		{#if showsSource}
			<textarea
				bind:this={textarea}
				bind:value
				{id}
				{placeholder}
				{onkeydown}
				onpaste={onPaste}
				oninput={updatePicker}
				onclick={() => {
					updatePicker();
					trackCaret();
				}}
				onkeyup={(e) => {
					if (e.key.startsWith('Arrow') && !picker) updatePicker();
					trackCaret();
				}}
				onblur={() => (picker = null)}
				role={picker ? 'combobox' : undefined}
				aria-expanded={picker ? pickerMatches.length > 0 : undefined}
				aria-controls={picker ? linkListId : undefined}
				aria-activedescendant={picker && pickerMatches.length
					? `${linkListId}-${pickerActive}`
					: undefined}
				spellcheck="true"
				class="block field-sizing-content w-full min-w-0 resize-none bg-transparent px-4 py-3 text-base leading-7 outline-none placeholder:text-muted-foreground md:text-[15px]"
				style:min-height={minHeight}></textarea>
			{#if picker}
				<div
					class="absolute z-30 w-72 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
					style:top="{picker.top}px"
					style:left="{picker.left}px"
					style:transform={picker.above ? 'translateY(-100%)' : undefined}
				>
					{#if pickerMatches.length}
						<ul
							id={linkListId}
							role="listbox"
							aria-label="Notes to link"
							class="max-h-64 overflow-y-auto p-1"
						>
							{#each pickerMatches as target, i (target.path)}
								<li
									id="{linkListId}-{i}"
									role="option"
									aria-selected={i === pickerActive}
									class="flex cursor-pointer flex-col rounded-md px-2 py-1.5 {i === pickerActive
										? 'bg-accent text-accent-foreground'
										: ''}"
									onpointerdown={(e) => {
										e.preventDefault();
										chooseLink(target);
									}}
									onpointerenter={() => (pickerActive = i)}
								>
									<span class="truncate text-sm">{target.title}</span>
									{#if target.hint}
										<span class="truncate text-xs text-muted-foreground">{target.hint}</span>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="px-3 py-2 text-sm text-muted-foreground">
							No notes match “{picker.query}”.{#if picker.query.trim()}
								Enter makes it a plain link.{/if}
						</p>
					{/if}
					{#if pickerMatches.length}
						<p class="border-t px-3 py-1.5 text-[11px] text-muted-foreground pointer-coarse:hidden">
							↑↓ to pick · Enter or Tab to link · Esc to close
						</p>
					{/if}
				</div>
			{/if}
		{/if}
		{#if mode !== 'write'}
			<div
				class="min-w-0 px-4 py-3 {mode === 'split' ? 'border-l bg-muted/20' : ''}"
				style:min-height={minHeight}
			>
				{#if value.trim()}
					<Markdown
						content={previewTransform ? previewTransform(previewSource) : previewSource}
						class="w-full max-w-none"
					/>
				{:else}
					<p class="text-sm text-muted-foreground">Your formatted note appears here.</p>
				{/if}
			</div>
		{/if}
	</div>

	<div
		class="flex items-center justify-between gap-2 border-t px-4 py-1.5 text-xs text-muted-foreground"
	>
		<span class="min-w-0 truncate">
			{#if linkTargets.length}Type <kbd class="font-mono">[[</kbd> to link a note{/if}
		</span>
		<span>{words} {words === 1 ? 'word' : 'words'}</span>
	</div>
</div>
