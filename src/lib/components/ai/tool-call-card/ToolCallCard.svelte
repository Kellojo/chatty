<script lang="ts">
	import { getToolOrDynamicToolName } from 'ai';
	import {
		describeTool,
		detailCoversInput,
		subagentActivity,
		toolFailed,
		toolOutcome,
		type SubagentPhase
	} from '$lib/tool-meta.js';
	import { resolveBrand } from '$lib/provider-brand.js';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import { cn } from '$lib/utils.js';
	import { formatElapsed } from '$lib/formats.js';
	import { now } from '$lib/state/now.svelte.js';
	import DiffStat from '$lib/components/app/DiffStat.svelte';
	import ToolIcon from './ToolIcon.svelte';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { TOOL_BODY_LIMIT, truncateHead, truncateTail } from './truncate.js';

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
	let {
		part,
		active = true,
		class: className
	}: { part: ToolPart; active?: boolean; class?: string } = $props();

	let open = $state(false);
	/** Shows the untruncated result instead of its first/last TOOL_BODY_LIMIT chars. */
	let showFull = $state(false);

	const name = $derived(getToolOrDynamicToolName(part as never));
	const display = $derived(describeTool(name, part.input));
	const outcome = $derived(toolOutcome(name, part.output));
	const incomplete = $derived(part.state === 'input-streaming' || part.state === 'input-available');
	const running = $derived(incomplete && active);
	const interrupted = $derived(incomplete && !active);
	const failed = $derived(toolFailed(part));

	// Subagents get a two-line row: status + task, then what they're doing or found.
	const subagent = $derived(display.kind === 'subagent');
	// A subagent can keep working after its parent turn ends; trust its own status then.
	const subagentRunning = $derived(
		running || (incomplete && (part.input as { running?: unknown } | undefined)?.running === true)
	);
	const phase = $derived<SubagentPhase>(
		subagentRunning ? 'running' : interrupted ? 'stopped' : failed ? 'failed' : 'done'
	);
	const PHASE_LABEL: Record<SubagentPhase, string> = {
		running: 'Running',
		done: 'Done',
		failed: 'Failed',
		stopped: 'Stopped'
	};
	const activity = $derived(
		subagent
			? subagentActivity(
					part.input,
					part.state === 'output-error' ? part.errorText : part.output,
					phase
				)
			: null
	);
	/** How long the subagent has been at work (live) or took, when T3 says. */
	const subagentDuration = $derived.by(() => {
		if (!subagent) return null;
		const args = (part.input ?? {}) as { startedAt?: unknown; completedAt?: unknown };
		if (typeof args.startedAt !== 'number') return null;
		if (phase === 'running') return formatElapsed(now() - args.startedAt);
		return typeof args.completedAt === 'number'
			? formatElapsed(args.completedAt - args.startedAt)
			: null;
	});
	const brand = $derived.by(() => {
		const args = (part.input ?? {}) as { provider?: unknown };
		return typeof args.provider === 'string' ? resolveBrand(args.provider) : null;
	});

	function asPrettyJson(value: unknown): string {
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
	}

	/** Unwraps a JSON string so structured results read as indented JSON. */
	function prettyText(text: string): string {
		const trimmed = text.trim();
		if (!/^[[{]/.test(trimmed)) return text;
		try {
			return JSON.stringify(JSON.parse(trimmed), null, 2);
		} catch {
			return text;
		}
	}

	/**
	 * Coding-agent items often only carry bookkeeping (`{ kind }`, `{ status: 'completed' }`,
	 * `{ done: true }`); showing that as a body adds clicks without information.
	 */
	function isTrivial(value: unknown): boolean {
		if (value == null) return true;
		if (typeof value !== 'object' || Array.isArray(value)) return false;
		return Object.entries(value).every(
			([key, v]) =>
				v == null ||
				typeof v === 'boolean' ||
				((key === 'kind' || key === 'status') && typeof v === 'string')
		);
	}

	function outputText(output: unknown): string {
		if (isTrivial(output) || diffStat) return '';
		if (typeof output === 'string') return output;
		if (typeof output === 'object') {
			const content = (output as { content?: unknown }).content;
			if (Array.isArray(content)) {
				const texts = content.map((c) =>
					c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : null
				);
				if (texts.every((t) => t !== null)) return prettyText(texts.join('\n'));
			}
			// Coding-agent command results carry the terminal output as a string,
			// or only a note when the output was never fetched.
			const result = output as { output?: unknown; note?: unknown; exitCode?: unknown };
			if (typeof result.output === 'string') return result.output;
			if (typeof result.note === 'string' && Object.keys(result).length <= 2) return '';
		}
		return asPrettyJson(output);
	}

	function inputText(input: unknown): string {
		if (isTrivial(input)) return '';
		const args = input as Record<string, unknown> | null;
		// A subagent's input is its task prompt; the rest is shown in the row itself.
		if (display.kind === 'subagent' && typeof args?.prompt === 'string') return args.prompt;
		if (args && Array.isArray(args.files) && Object.keys(args).length === 1) {
			return args.files.join('\n');
		}
		// Show code and commands as written instead of an escaped JSON string.
		for (const key of ['command', 'code']) {
			const value = args?.[key];
			if (typeof value === 'string' && Object.keys(args ?? {}).length === 1) return value;
		}
		return asPrettyJson(input);
	}

	/** Terminal output matters most at the end (summary, error), so start scrolled there. */
	function scrollToEnd(node: HTMLElement) {
		if (display.kind === 'command') node.scrollTop = node.scrollHeight;
	}

	const exitCode = $derived(
		part.output && typeof part.output === 'object'
			? (part.output as { exitCode?: unknown }).exitCode
			: undefined
	);
	/** Line counts reported by coding-agent file edits. */
	const diffStat = $derived.by(() => {
		const out = part.output as { additions?: unknown; deletions?: unknown } | undefined;
		if (!out || typeof out !== 'object') return null;
		const keys = Object.keys(out);
		if (keys.length !== 2 || !keys.every((k) => k === 'additions' || k === 'deletions'))
			return null;
		return {
			insertions: typeof out.additions === 'number' ? out.additions : 0,
			deletions: typeof out.deletions === 'number' ? out.deletions : 0
		};
	});
	/** Whether outputText() would be non-empty, without serialising the output. */
	function hasOutputText(output: unknown): boolean {
		if (isTrivial(output) || diffStat) return false;
		if (typeof output === 'string') return output !== '';
		if (typeof output === 'object') {
			const content = (output as { content?: unknown }).content;
			if (Array.isArray(content)) {
				const texts = content.map((c) =>
					c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : null
				);
				if (texts.every((t) => t !== null)) return texts.some((t) => t !== '');
			}
			const result = output as { output?: unknown; note?: unknown };
			if (typeof result.output === 'string') return result.output !== '';
			if (typeof result.note === 'string' && Object.keys(result).length <= 2) return false;
		}
		return true;
	}

	// The message being streamed is replaced on every chunk, so anything derived
	// from it re-runs per token. Serialising large tool inputs/outputs is the
	// expensive part: only do it once the body is actually shown (or, for a
	// failed call, to summarise its error).
	const hasResult = $derived(
		part.state === 'output-error' ? !!part.errorText : hasOutputText(part.output)
	);
	const inputBody = $derived(open ? truncateHead(inputText(part.input)) : '');
	const resultText = $derived(
		open || failed
			? part.state === 'output-error'
				? (part.errorText ?? '')
				: outputText(part.output)
			: ''
	);
	const resultTruncated = $derived(resultText.length > TOOL_BODY_LIMIT);
	// Terminal output keeps its end, where the summary or error is.
	const resultBody = $derived(
		showFull || !resultTruncated
			? resultText
			: display.kind === 'command'
				? truncateTail(resultText)
				: truncateHead(resultText)
	);
	// Don't repeat an input the row already shows in full (a short command, a query).
	const showInput = $derived(
		!isTrivial(part.input) && !detailCoversInput(part.input, display.detail)
	);
	/** Failed calls without a detail show the first line of their error instead. */
	const detail = $derived(display.detail ?? (failed ? errorSummary(resultText) : null));

	/** First line of an error, without the coding agent's generic lead-in. */
	function errorSummary(text: string): string | null {
		const line = text.split('\n').find((l) => l.trim());
		if (!line) return null;
		const cause = line.replace(/^The coding agent reported an error:\s*/i, '');
		return cause ? cause.charAt(0).toUpperCase() + cause.slice(1) : line;
	}
	const hasBody = $derived(showInput || hasResult || running);
	const labelled = $derived(showInput && hasResult);
</script>

<div class={cn('w-full min-w-0 text-sm', className)}>
	{#if subagent}
		<button
			type="button"
			class={cn(
				'group/tool flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
				hasBody
					? 'hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
					: 'cursor-default'
			)}
			aria-expanded={hasBody ? open : undefined}
			disabled={!hasBody}
			onclick={() => (open = !open)}
		>
			<span class="flex h-5 w-5 shrink-0 items-center justify-center">
				{#if phase === 'running'}
					<Loader2Icon class="size-4 animate-spin text-info" />
				{:else if phase === 'done'}
					<CircleCheckIcon class="size-4 text-success" />
				{:else if phase === 'failed'}
					<TriangleAlertIcon class="size-4 text-destructive" />
				{:else}
					<CircleSlashIcon class="size-4 text-muted-foreground" />
				{/if}
			</span>
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="flex min-w-0 items-center gap-1.5">
					{#if brand}
						<ProviderIcon {brand} class="size-3.5 shrink-0" />
					{/if}
					<span class="truncate font-medium text-foreground/90" title={display.detail ?? undefined}>
						{display.detail ?? display.label}
					</span>
				</span>
				{#if activity}
					<span
						class={cn(
							'truncate text-xs',
							phase === 'running' ? 'text-info-foreground' : 'text-muted-foreground',
							phase === 'failed' && 'text-destructive/80'
						)}
						title={activity}>{activity}</span
					>
				{/if}
			</span>
			<span
				class={cn(
					'flex h-5 shrink-0 items-center gap-1.5 pl-2 text-xs',
					phase === 'running' && 'text-info-foreground',
					phase === 'done' && 'text-success-foreground',
					phase === 'failed' && 'text-destructive',
					phase === 'stopped' && 'text-muted-foreground'
				)}
			>
				{PHASE_LABEL[phase]}
				{#if subagentDuration}
					<span
						class="text-muted-foreground tabular-nums"
						title={phase === 'running'
							? `Running for ${subagentDuration}`
							: `Took ${subagentDuration}`}>· {subagentDuration}</span
					>
				{/if}
				<ChevronRightIcon
					aria-hidden="true"
					class={cn(
						'size-3.5 text-muted-foreground transition',
						hasBody
							? 'opacity-50 group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100'
							: 'invisible',
						open && 'rotate-90 opacity-100'
					)}
				/>
			</span>
		</button>
	{:else}
		<button
			type="button"
			class={cn(
				'group/tool flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors pointer-coarse:py-2',
				hasBody
					? 'hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
					: 'cursor-default'
			)}
			aria-expanded={hasBody ? open : undefined}
			disabled={!hasBody}
			onclick={() => (open = !open)}
		>
			<span
				class={cn(
					'flex size-5 shrink-0 items-center justify-center text-muted-foreground',
					failed && 'text-destructive'
				)}
			>
				{#if running}
					<Loader2Icon class="size-3.5 animate-spin" />
				{:else if interrupted}
					<!-- The message footer explains the stop; the row only marks which call it hit. -->
					<CircleSlashIcon class="size-3.5" aria-hidden="true" />
					<span class="sr-only">Stopped</span>
				{:else if failed}
					<TriangleAlertIcon class="size-3.5" />
				{:else}
					<ToolIcon kind={display.kind} class="size-3.5" />
				{/if}
			</span>
			<span class="shrink-0 font-medium text-foreground/90">{display.label}</span>
			{#if detail}
				<span
					class={cn(
						'min-w-0 truncate text-xs',
						// The icon and "Failed" already say it went wrong; the excerpt stays readable grey.
						'text-muted-foreground',
						!display.prose && display.detail && 'font-mono'
					)}
					title={detail}>{detail}</span
				>
			{/if}
			<span class="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
				{#if failed && display.kind !== 'error'}
					<span class="text-destructive">
						{typeof exitCode === 'number' && exitCode !== 0 ? `Exit ${exitCode}` : 'Failed'}
					</span>
				{:else if outcome}
					<span class={outcome.negative ? 'text-destructive' : undefined}>{outcome.label}</span>
				{:else if diffStat}
					<DiffStat diff={diffStat} />
				{/if}
				<ChevronRightIcon
					aria-hidden="true"
					class={cn(
						'size-3.5 transition',
						hasBody
							? 'opacity-50 group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100'
							: 'invisible',
						open && 'rotate-90 opacity-100'
					)}
				/>
			</span>
		</button>
	{/if}
	{#if open && hasBody}
		<div class="mt-1 mb-2 ml-1 flex flex-col gap-2 sm:ml-9">
			{#if showInput}
				<div>
					{#if labelled}
						<p class="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
							{subagent ? 'Task' : 'Input'}
						</p>
					{/if}
					<pre
						class="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{inputBody}</pre>
				</div>
			{/if}
			{#if running && !resultBody}
				<p class="text-xs text-muted-foreground">Running…</p>
			{/if}
			{#if resultBody}
				<div>
					{#if labelled}
						<p class="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
							{failed ? 'Error' : subagent ? 'Result' : 'Output'}
						</p>
					{/if}
					<pre
						{@attach (node) => {
							void showFull;
							scrollToEnd(node);
						}}
						class={cn(
							'max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap',
							failed && 'border-destructive/30 text-destructive'
						)}>{resultBody}</pre>
					{#if resultTruncated}
						<button
							type="button"
							class="mt-1 rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
							aria-pressed={showFull}
							onclick={() => (showFull = !showFull)}
						>
							{showFull
								? 'Show less'
								: `Show full output (${resultText.length.toLocaleString()} chars)`}
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
