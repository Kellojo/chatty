<script lang="ts">
	import { tick } from 'svelte';
	import PendingAttachment from './PendingAttachment.svelte';

	let { files, onremove }: { files: File[]; onremove: (file: File) => void } = $props();

	let list = $state<HTMLUListElement>();

	// Removing destroys the focused button; keep keyboard users in place by moving
	// focus to the next remove button, or back to the composer when none are left.
	async function remove(file: File, index: number) {
		const textarea = list?.parentElement?.querySelector<HTMLElement>('textarea[data-composer]');
		onremove(file);
		await tick();
		const buttons = list?.querySelectorAll<HTMLElement>('[data-remove]') ?? [];
		(buttons[Math.min(index, buttons.length - 1)] ?? textarea)?.focus();
	}
</script>

{#if files.length > 0}
	<!-- One scrolling row on narrow screens so the composer doesn't grow, faded at the
	     edges to hint at more (the padding keeps the end cards clear of the fade); wraps
	     on wider ones. pt-2 leaves room for the remove buttons above each tile. -->
	<ul
		bind:this={list}
		class="-mx-2 flex [scrollbar-width:none] gap-2.5 overflow-x-auto [mask-image:linear-gradient(to_right,transparent,#000_16px,#000_calc(100%-24px),transparent)] pt-2 pr-10 pb-2 pl-5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:[mask-image:none] sm:px-3"
		aria-label={files.length === 1 ? '1 attachment' : `${files.length} attachments`}
	>
		{#each files as file, i (file)}
			<li class="shrink-0">
				<PendingAttachment {file} onremove={() => remove(file, i)} />
			</li>
		{/each}
	</ul>
{/if}
