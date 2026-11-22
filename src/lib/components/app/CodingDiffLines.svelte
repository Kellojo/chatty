<script lang="ts" module>
	import { newLineNumbers, type CodingDiffLine } from '$lib/coding-diff.js';

	const LINE_CLASS = {
		add: 'bg-success/10',
		del: 'bg-destructive/10',
		context: '',
		hunk: 'bg-muted text-muted-foreground',
		meta: 'text-muted-foreground italic'
	} as const;
	const LINE_SIGN = { add: '+', del: '-', context: ' ', hunk: '', meta: '' } as const;
</script>

<script lang="ts">
	/**
	 * One file's unified diff lines, scrolling sideways when they're long.
	 * `highlight` marks the line with that number in the file's current version.
	 */
	let { lines, highlight = null }: { lines: CodingDiffLine[]; highlight?: number | null } =
		$props();

	const numbers = $derived(newLineNumbers(lines));
</script>

<div class="overflow-x-auto">
	<pre class="min-w-max font-mono text-xs leading-5 [tab-size:4]">{#each lines as line, i (i)}<div
				class="px-3 {highlight !== null && numbers[i] === highlight
					? 'bg-amber-400/25 shadow-[inset_3px_0_0_var(--color-amber-500)]'
					: LINE_CLASS[line.kind]}"
				data-new-line={numbers[i] ?? undefined}
				aria-current={highlight !== null && numbers[i] === highlight ? 'location' : undefined}><span
					class="inline-block w-3 text-muted-foreground select-none"
					aria-hidden="true">{LINE_SIGN[line.kind]}</span
				>{line.text}</div>{/each}</pre>
</div>
