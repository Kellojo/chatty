<script lang="ts" module>
	export type Concept = 'chats' | 'memory' | 'agents' | 'tools' | 'coding' | 'gateway' | 'api';
</script>

<script lang="ts">
	import BrainIcon from '@lucide/svelte/icons/brain';
	import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CloudSunIcon from '@lucide/svelte/icons/cloud-sun';
	import CodeIcon from '@lucide/svelte/icons/code';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import GitPullRequestIcon from '@lucide/svelte/icons/git-pull-request';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';

	/**
	 * A looping illustration of one concept. Every element's resting style is the
	 * scene's final frame, so with reduced motion (animations off) it still reads.
	 */
	let { concept }: { concept: Concept } = $props();
</script>

<div class="scene relative h-full w-full overflow-hidden" aria-hidden="true">
	{#if concept === 'chats'}
		<div class="flex h-full flex-col justify-center gap-3 px-6 sm:px-10">
			<div
				class="mx-auto flex items-center gap-2 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium shadow-xs"
			>
				<span class="relative size-4">
					<span class="brand b1 absolute inset-0"
						><ProviderIcon brand="claude" class="size-4" decorative /></span
					>
					<span class="brand b2 absolute inset-0"
						><ProviderIcon brand="openai" class="size-4" decorative /></span
					>
					<span class="brand b3 absolute inset-0"
						><ProviderIcon brand="ollama" class="size-4" decorative /></span
					>
				</span>
				<span class="relative h-4 w-20 text-left">
					<span class="brand b1 absolute inset-0">Claude</span>
					<span class="brand b2 absolute inset-0">GPT</span>
					<span class="brand b3 absolute inset-0">Llama · local</span>
				</span>
			</div>
			<div
				class="chat-user ml-auto max-w-[75%] rounded-2xl rounded-br-md bg-foreground px-3.5 py-2 text-sm text-background"
			>
				Plan a 3-day trip to Lisbon
			</div>
			<div
				class="flex max-w-[85%] flex-col gap-1.5 rounded-2xl rounded-bl-md border border-border bg-card px-3.5 py-3 shadow-xs"
			>
				<span class="stream s1 h-2 w-[92%] rounded-full bg-foreground/15"></span>
				<span class="stream s2 h-2 w-[78%] rounded-full bg-foreground/15"></span>
				<span class="stream s3 h-2 w-[64%] rounded-full bg-foreground/15"></span>
			</div>
		</div>
	{:else if concept === 'memory'}
		<div class="grid h-full grid-cols-[1fr_auto] items-center gap-4 px-6 sm:px-8">
			<div class="flex flex-col gap-3">
				<div
					class="ml-auto max-w-[95%] rounded-2xl rounded-br-md bg-foreground px-3.5 py-2 text-sm text-background"
				>
					I mostly write <mark class="mem-mark rounded bg-chart-3/40 px-0.5 text-inherit"
						>TypeScript</mark
					> these days
				</div>
				<div
					class="flex flex-col gap-1.5 rounded-2xl rounded-bl-md border border-border bg-card px-3.5 py-3 shadow-xs"
				>
					<span class="h-2 w-[86%] rounded-full bg-foreground/15"></span>
					<span class="h-2 w-[60%] rounded-full bg-foreground/15"></span>
				</div>
			</div>
			<div
				class="relative flex w-36 flex-col gap-1.5 rounded-2xl border border-border bg-background p-2.5 shadow-sm sm:w-44"
			>
				<span class="mb-0.5 flex items-center gap-1.5 text-xs font-medium">
					<BrainIcon class="size-3.5" />Memory
				</span>
				<!-- The slot is always drawn, so the list never shows a hole before the fact lands. -->
				<span class="rounded-lg border border-dashed border-chart-3/40">
					<span
						class="mem-new flex items-center gap-1.5 rounded-lg bg-chart-3/15 px-2 py-1.5 text-xs"
					>
						<SparklesIcon class="size-3 shrink-0 text-chart-3" />Prefers TypeScript
					</span>
				</span>
				<span class="rounded-lg bg-muted px-2 py-1.5 text-xs text-muted-foreground"
					>Lives in Berlin</span
				>
				<span class="rounded-lg bg-muted px-2 py-1.5 text-xs text-muted-foreground"
					>Likes short answers</span
				>
			</div>
		</div>
	{:else if concept === 'agents'}
		<div class="flex h-full items-center justify-center px-6">
			<div class="w-full max-w-xs rounded-2xl border border-border bg-background p-4 shadow-sm">
				<div class="flex items-center gap-3">
					<span class="flex size-9 items-center justify-center rounded-xl bg-muted">
						<CalendarClockIcon class="size-[1.125rem]" />
					</span>
					<div class="flex min-w-0 flex-1 flex-col">
						<span class="text-sm font-medium">Morning briefing</span>
						<span class="text-xs text-muted-foreground">Weekdays at 8:00</span>
					</div>
					<span class="relative h-5 w-16 text-[0.6875rem] font-medium">
						<span
							class="status st1 absolute inset-0 flex items-center justify-center rounded-full bg-muted text-muted-foreground"
							>Scheduled</span
						>
						<span
							class="status st2 absolute inset-0 flex items-center justify-center rounded-full bg-info/15 text-info-foreground"
							>Running</span
						>
						<span
							class="status st3 absolute inset-0 flex items-center justify-center rounded-full bg-success/15 text-success-foreground"
							>Done</span
						>
					</span>
				</div>
				<ol class="mt-3 flex flex-col gap-2 border-t border-border/70 pt-3 text-xs">
					{#each ['Check the news', 'Read my calendar', 'Write a summary'] as task, i (task)}
						<li class="flex items-center gap-2">
							<span
								class="tick t{i +
									1} flex size-4 items-center justify-center rounded-full bg-success text-background"
							>
								<CheckIcon class="size-2.5" />
							</span>
							<span class="text-muted-foreground">{task}</span>
						</li>
					{/each}
				</ol>
				<div class="mt-3 h-1 overflow-hidden rounded-full bg-muted">
					<span class="bar block h-full rounded-full bg-success"></span>
				</div>
			</div>
		</div>
	{:else if concept === 'coding'}
		<div class="flex h-full items-center justify-center px-5">
			<div
				class="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-background shadow-sm"
			>
				<div class="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
					<ProviderIcon brand="claude" class="size-3.5" decorative />
					<span class="text-xs font-medium">Fix the failing tests</span>
					<span class="ml-auto font-mono text-[0.6875rem] text-muted-foreground">ai-chat</span>
				</div>
				<div class="flex flex-col gap-1 px-3.5 py-3 font-mono text-[0.6875rem] leading-relaxed">
					<span class="term l1 text-muted-foreground">$ pnpm test</span>
					<span class="term l2"
						><span class="text-destructive">✗</span> 2 failing in auth.spec.ts</span
					>
					<span class="term l3 text-muted-foreground">Editing src/lib/auth.ts…</span>
					<span class="term l4"><span class="text-success-foreground">✓</span> 148 passing</span>
				</div>
				<div class="flex items-center gap-2 border-t border-border/70 px-3.5 py-2.5">
					<span class="diff font-mono text-[0.6875rem]">
						<span class="text-success-foreground">+42</span>
						<span class="text-destructive">−7</span>
					</span>
					<span
						class="pr ml-auto inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[0.6875rem] font-medium text-success-foreground"
					>
						<GitPullRequestIcon class="size-3" />PR #128 opened
					</span>
				</div>
			</div>
		</div>
	{:else if concept === 'gateway'}
		<div
			class="relative grid h-full grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:gap-6 sm:px-8"
		>
			<div class="flex flex-col items-end gap-2">
				{#each [{ brand: 'claude' as const, label: 'Claude Code' }, { brand: 'openai' as const, label: 'Codex' }, { brand: 'opencode' as const, label: 'OpenCode' }] as client (client.label)}
					<span
						class="flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium shadow-xs"
					>
						<ProviderIcon brand={client.brand} class="size-3.5" decorative />{client.label}
					</span>
				{/each}
			</div>
			<div class="relative flex flex-col items-center gap-1.5">
				<svg
					class="flow pointer-events-none absolute top-1/2 left-1/2 h-24 w-[calc(100%+1.5rem)] -translate-x-1/2 -translate-y-1/2 text-foreground/25 sm:w-[calc(100%+3rem)]"
					viewBox="0 0 200 100"
					preserveAspectRatio="none"
				>
					<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 5">
						<path d="M0 20 C 60 20, 60 50, 100 50" /><path d="M0 50 L100 50" /><path
							d="M0 80 C 60 80, 60 50, 100 50"
						/>
						<path d="M100 50 C 140 50, 140 20, 200 20" /><path d="M100 50 L200 50" /><path
							d="M100 50 C 140 50, 140 80, 200 80"
						/>
					</g>
				</svg>
				<svg
					viewBox="0 0 24 24"
					class="relative size-11 rounded-xl bg-foreground text-background shadow-md"
				>
					<g
						transform="translate(3.5 3.5) scale(0.7083)"
						fill="none"
						stroke="currentColor"
						stroke-width="2.4"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M5.5 6.5l5 5.5-5 5.5" /><path d="M12.5 18h6" />
					</g>
				</svg>
				<span
					class="relative rounded-full bg-muted px-2 py-0.5 font-mono text-[0.625rem] text-muted-foreground"
					>/api/mcp</span
				>
			</div>
			<div class="flex flex-col items-start gap-2">
				{#each [{ icon: BrainIcon, label: 'Memory' }, { icon: HistoryIcon, label: 'Past chats' }, { icon: ScrollTextIcon, label: 'Skills' }] as tool, i (tool.label)}
					<span
						class="tool tl{i +
							1} flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium shadow-xs"
					>
						<tool.icon class="size-3.5" />{tool.label}
					</span>
				{/each}
			</div>
		</div>
	{:else if concept === 'api'}
		<div class="flex h-full flex-col items-center justify-center gap-3 px-5">
			<div
				class="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-background shadow-sm"
			>
				<div
					class="flex items-center gap-1.5 border-b border-border/70 px-3.5 py-2 font-mono text-[0.6875rem]"
				>
					<span
						class="rounded bg-foreground px-1.5 py-px text-[0.625rem] font-semibold text-background"
						>POST</span
					>
					<span class="text-muted-foreground">/api/v1/chat/completions</span>
				</div>
				<div class="flex flex-col gap-0.5 px-3.5 py-2.5 font-mono text-[0.6875rem] leading-relaxed">
					<span><span class="text-muted-foreground">Authorization:</span> Bearer sk-chatty-…</span>
					<span><span class="text-muted-foreground">model:</span> "claude-sonnet"</span>
				</div>
				<div class="flex flex-col gap-1.5 border-t border-border/70 bg-muted/40 px-3.5 py-3">
					<span class="stream s1 h-1.5 w-[88%] rounded-full bg-foreground/20"></span>
					<span class="stream s2 h-1.5 w-[70%] rounded-full bg-foreground/20"></span>
				</div>
			</div>
			<div class="flex flex-wrap justify-center gap-1.5 font-mono text-[0.625rem]">
				{#each ['/responses', '/audio/speech', '/audio/transcriptions', '/models'] as endpoint, i (endpoint)}
					<span
						class="tool tl{i +
							1} rounded-full border border-border bg-card px-2 py-0.5 text-muted-foreground"
						>{endpoint}</span
					>
				{/each}
			</div>
		</div>
	{:else}
		<div class="relative flex h-full items-center justify-center">
			<svg
				class="absolute inset-0 h-full w-full text-border"
				viewBox="0 0 400 240"
				preserveAspectRatio="none"
			>
				<g stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 4" fill="none">
					<path d="M200 120 L80 55" /><path d="M200 120 L320 55" />
					<path d="M200 120 L80 185" /><path d="M200 120 L320 185" />
				</g>
			</svg>
			<div
				class="relative z-10 flex items-center gap-2 rounded-2xl border border-border bg-background px-4 py-3 shadow-md"
			>
				<SparklesIcon class="size-4" />
				<span class="text-sm font-medium">Your assistant</span>
			</div>
			{#each [{ icon: GlobeIcon, label: 'Web search', pos: 'left-[8%] top-[14%]' }, { icon: CodeIcon, label: 'Run code', pos: 'right-[8%] top-[14%]' }, { icon: FileTextIcon, label: 'Your files', pos: 'left-[8%] bottom-[14%]' }, { icon: CloudSunIcon, label: 'Weather', pos: 'right-[8%] bottom-[14%]' }] as tool, i (tool.label)}
				<span
					class="tool tl{i +
						1} absolute {tool.pos} flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium shadow-xs"
				>
					<tool.icon class="size-3.5" />{tool.label}
				</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.scene {
		--loop: 6s;
	}

	/* Chats: the model chip cycles providers while the reply streams in. */
	.brand {
		opacity: 0;
		animation: brand-cycle var(--loop) infinite;
	}
	.b1 {
		opacity: 1;
		animation-delay: 0s;
	}
	.b2 {
		animation-delay: -4s;
	}
	.b3 {
		animation-delay: -2s;
	}
	@keyframes brand-cycle {
		0%,
		30% {
			opacity: 1;
			transform: none;
		}
		33.3%,
		97% {
			opacity: 0;
			transform: translateY(-4px);
		}
		100% {
			opacity: 1;
		}
	}
	.chat-user {
		animation: pop-in calc(var(--loop) / 3) infinite;
	}
	.stream {
		transform-origin: left;
		animation: stream calc(var(--loop) / 3) infinite;
	}
	.s2 {
		animation-delay: 0.12s;
	}
	.s3 {
		animation-delay: 0.24s;
	}
	@keyframes pop-in {
		0% {
			opacity: 0;
			transform: translateY(6px) scale(0.97);
		}
		12%,
		100% {
			opacity: 1;
			transform: none;
		}
	}
	@keyframes stream {
		0%,
		20% {
			transform: scaleX(0);
			opacity: 0;
		}
		60%,
		100% {
			transform: scaleX(1);
			opacity: 1;
		}
	}

	/* Memory: the fact gets highlighted, then lands in the memory list. */
	.mem-mark {
		animation: mark var(--loop) infinite;
	}
	@keyframes mark {
		0%,
		15% {
			background: transparent;
		}
		25%,
		100% {
			background: color-mix(in oklch, var(--chart-3) 40%, transparent);
		}
	}
	.mem-new {
		animation: mem-land var(--loop) infinite;
	}
	@keyframes mem-land {
		0%,
		30% {
			opacity: 0;
			transform: translateX(-60px) scale(0.85);
		}
		45% {
			opacity: 1;
			transform: translateX(4px) scale(1.04);
		}
		52%,
		100% {
			opacity: 1;
			transform: none;
		}
	}

	/* Agents: scheduled → running → done, ticking off its tasks. */
	.status {
		opacity: 0;
		animation: status-1 var(--loop) infinite;
	}
	.st3 {
		opacity: 1;
	}
	.st1 {
		animation-name: status-1;
	}
	.st2 {
		animation-name: status-2;
	}
	.st3 {
		animation-name: status-3;
	}
	@keyframes status-1 {
		0%,
		18% {
			opacity: 1;
		}
		22%,
		100% {
			opacity: 0;
		}
	}
	@keyframes status-2 {
		0%,
		18% {
			opacity: 0;
		}
		22%,
		72% {
			opacity: 1;
		}
		76%,
		100% {
			opacity: 0;
		}
	}
	@keyframes status-3 {
		0%,
		72% {
			opacity: 0;
		}
		76%,
		100% {
			opacity: 1;
		}
	}
	.tick {
		animation: tick-1 var(--loop) infinite;
	}
	.t2 {
		animation-name: tick-2;
	}
	.t3 {
		animation-name: tick-3;
	}
	@keyframes tick-1 {
		0%,
		32% {
			transform: scale(0);
		}
		38%,
		100% {
			transform: none;
		}
	}
	@keyframes tick-2 {
		0%,
		48% {
			transform: scale(0);
		}
		54%,
		100% {
			transform: none;
		}
	}
	@keyframes tick-3 {
		0%,
		64% {
			transform: scale(0);
		}
		70%,
		100% {
			transform: none;
		}
	}
	.bar {
		transform-origin: left;
		animation: bar var(--loop) infinite;
	}
	@keyframes bar {
		0%,
		20% {
			transform: scaleX(0);
		}
		72%,
		100% {
			transform: scaleX(1);
		}
	}

	/* Tools: each lights up in turn as the assistant reaches for it. */
	.tool {
		animation: tool var(--loop) infinite;
	}
	.tl2 {
		animation-delay: 1.5s;
	}
	.tl3 {
		animation-delay: 3s;
	}
	.tl4 {
		animation-delay: 4.5s;
	}
	@keyframes tool {
		0%,
		100% {
			transform: none;
			box-shadow: none;
		}
		8%,
		18% {
			transform: scale(1.08);
			border-color: var(--foreground);
			box-shadow: 0 0 0 4px color-mix(in oklch, var(--foreground) 10%, transparent);
		}
		26% {
			transform: none;
			box-shadow: none;
		}
	}

	/* Coding: the agent works through the task, then opens a pull request. */
	.term {
		animation: term var(--loop) infinite;
	}
	.l2 {
		animation-name: term-2;
	}
	.l3 {
		animation-name: term-3;
	}
	.l4 {
		animation-name: term-4;
	}
	@keyframes term {
		0%,
		4% {
			opacity: 0;
		}
		8%,
		100% {
			opacity: 1;
		}
	}
	@keyframes term-2 {
		0%,
		16% {
			opacity: 0;
		}
		20%,
		100% {
			opacity: 1;
		}
	}
	@keyframes term-3 {
		0%,
		30% {
			opacity: 0;
		}
		34%,
		100% {
			opacity: 1;
		}
	}
	@keyframes term-4 {
		0%,
		48% {
			opacity: 0;
		}
		52%,
		100% {
			opacity: 1;
		}
	}
	.diff {
		animation: term-4 var(--loop) infinite;
	}
	.pr {
		animation: pr var(--loop) infinite;
	}
	@keyframes pr {
		0%,
		64% {
			opacity: 0;
			transform: scale(0.8);
		}
		70% {
			opacity: 1;
			transform: scale(1.06);
		}
		74%,
		100% {
			opacity: 1;
			transform: none;
		}
	}

	/* Gateway: requests flow from the clients through Chatty to its tools. */
	.flow path {
		animation: flow 1.2s linear infinite;
	}
	@keyframes flow {
		to {
			stroke-dashoffset: -16;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.scene :global(*) {
			animation: none !important;
		}
	}
</style>
