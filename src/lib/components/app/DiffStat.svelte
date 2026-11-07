<script lang="ts">
	import type { CodingDiffStat } from '$lib/coding-environments.js';
	import { formatCount } from '$lib/formats.js';

	/** `+12 −3` change size of a coding task; renders nothing for an empty diff. */
	let { diff, class: className = '' }: { diff: CodingDiffStat | null; class?: string } = $props();
</script>

{#if diff && (diff.insertions > 0 || diff.deletions > 0)}
	<span
		class="inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums {className}"
		title="{diff.insertions.toLocaleString()} lines added, {diff.deletions.toLocaleString()} removed"
	>
		<span class="text-success-foreground">+{formatCount(diff.insertions)}</span>
		<span class="text-destructive">−{formatCount(diff.deletions)}</span>
	</span>
{/if}
