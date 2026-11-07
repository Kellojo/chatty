<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';

	let {
		code,
		label
	}: { code: string; /** What is copied, for the button label. */ label: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(code);
			copied = true;
			clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 1500);
		} catch {
			toast.error('Could not copy to the clipboard');
		}
	}
</script>

<div class="group/code relative">
	<pre
		class="overflow-x-auto rounded-xl border border-border/60 bg-muted/50 p-3 pr-12 font-mono text-xs leading-relaxed">{code}</pre>
	<Button
		variant="ghost"
		size="icon-sm"
		class="absolute top-1.5 right-1.5 bg-background/80 backdrop-blur"
		onclick={copy}
		aria-label={copied ? 'Copied' : `Copy ${label}`}
		title={copied ? 'Copied' : 'Copy'}
	>
		{#if copied}
			<CheckIcon class="size-4" />
		{:else}
			<CopyIcon class="size-4" />
		{/if}
	</Button>
</div>
