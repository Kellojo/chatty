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

<div class="overflow-hidden rounded-xl border border-border/60 bg-muted/50">
	<div class="flex items-center justify-between gap-2 border-b border-border/60 py-1 pr-1 pl-3">
		<span class="text-xs text-muted-foreground">{label}</span>
		<Button
			variant="ghost"
			size="icon-sm"
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
	<pre class="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{code}</pre>
</div>
