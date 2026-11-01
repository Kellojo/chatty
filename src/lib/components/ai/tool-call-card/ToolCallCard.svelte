<script lang="ts">
	import { getToolOrDynamicToolName } from 'ai';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { TOOL_META } from '$lib/tool-meta.js';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import CheckIcon from '@lucide/svelte/icons/check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	type ToolPart = {
		type: string;
		toolCallId: string;
		state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
		input?: unknown;
		output?: unknown;
		errorText?: string;
	};

	// `active`: the response this call belongs to is still being generated. If not,
	// a call without a result was interrupted and will never finish.
	let { part, active = true }: { part: ToolPart; active?: boolean } = $props();

	let open = $state(false);

	const name = $derived(getToolOrDynamicToolName(part as never));
	const meta = $derived(TOOL_META[name]);
	const incomplete = $derived(part.state === 'input-streaming' || part.state === 'input-available');
	const running = $derived(incomplete && active);
	const failed = $derived(part.state === 'output-error');

	function asPrettyJson(value: unknown): string {
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
	}

	function truncate(text: string): string {
		return text.length > 4000 ? text.slice(0, 4000) + '\n… truncated' : text;
	}

	function outputText(output: unknown): string {
		if (output == null) return '';
		if (typeof output === 'string') return output;
		if (typeof output === 'object' && 'content' in output) {
			const content = (output as { content?: unknown }).content;
			if (Array.isArray(content)) {
				const texts = content.map((c) =>
					c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : null
				);
				if (texts.every((t) => t !== null)) return texts.join('\n');
			}
		}
		return asPrettyJson(output);
	}

	const inputText = $derived(part.input === undefined ? '' : truncate(asPrettyJson(part.input)));
	const resultText = $derived(truncate(failed ? (part.errorText ?? '') : outputText(part.output)));
</script>

<div class="w-full max-w-2xl rounded-md border bg-muted/30 text-sm">
	<button
		type="button"
		class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<WrenchIcon class="size-4 shrink-0 text-muted-foreground" />
		<span class="font-medium">{meta?.label ?? name}</span>
		{#if meta}
			<Badge variant="outline" class="text-xs">{meta.server}</Badge>
		{/if}
		<span class="ml-auto flex items-center gap-1.5">
			{#if running}
				<Loader2Icon class="size-4 animate-spin text-muted-foreground" />
			{:else if failed}
				<TriangleAlertIcon class="size-4 text-destructive" />
			{:else if !incomplete}
				<CheckIcon class="size-4 text-muted-foreground" />
			{/if}
			<ChevronDownIcon
				class="size-4 text-muted-foreground transition-transform {open ? 'rotate-180' : ''}"
			/>
		</span>
	</button>
	{#if open}
		<div class="flex flex-col gap-2 border-t px-3 py-2">
			{#if inputText}
				<div>
					<p class="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
						Input
					</p>
					<pre
						class="max-h-64 overflow-auto rounded bg-background p-2 font-mono text-xs break-all whitespace-pre-wrap">{inputText}</pre>
				</div>
			{/if}
			{#if running && !inputText}
				<p class="text-xs text-muted-foreground">Running…</p>
			{/if}
			{#if resultText}
				<div>
					<p class="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
						{failed ? 'Error' : 'Output'}
					</p>
					<pre
						class="max-h-64 overflow-auto rounded bg-background p-2 font-mono text-xs break-all whitespace-pre-wrap {failed
							? 'text-destructive'
							: ''}">{resultText}</pre>
				</div>
			{/if}
		</div>
	{/if}
</div>
