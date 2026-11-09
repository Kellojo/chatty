<script lang="ts">
	import { resolve } from '$app/paths';
	import BotIcon from '@lucide/svelte/icons/bot';
	import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import HandIcon from '@lucide/svelte/icons/hand';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import PlayIcon from '@lucide/svelte/icons/play';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import InfoIcon from '@lucide/svelte/icons/info';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { Button } from '$lib/components/ui/button/index.js';
	import { describeCron, parseCron } from '$lib/cron.js';
	import { agentDisplayName, EVENT_LABELS, ordinal, TRIGGER_LABELS } from '$lib/agent-labels.js';
	import type { AgentEventName, AgentTriggerType } from '$lib/types.js';
	import WidgetCard from './widget-card.svelte';

	/**
	 * An ```agent fence: the agent create_agent / get_agent / update_agent
	 * returned, as a card with its schedule, model and tools, plus Open and
	 * Run buttons so an agent made in chat ends with something to act on.
	 */
	type AgentCard = {
		id: string;
		name: string;
		description: string | null;
		triggerType: AgentTriggerType;
		cron: string | null;
		event: AgentEventName | null;
		every: number;
		model: string | null;
		tools: string[] | null;
		skills: string[];
		coding: string | null;
		enabled: boolean;
		nextRunAt: number | null;
	};

	type Props = {
		code: string;
		isIncomplete: boolean;
	};

	let { code, isIncomplete }: Props = $props();

	const rec = (v: unknown): Record<string, unknown> | null =>
		typeof v === 'object' && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
	const num = (v: unknown): number | null =>
		typeof v === 'number' && Number.isFinite(v) ? v : null;
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.map(str).filter((s): s is string => s !== null) : [];

	const agent = $derived.by((): AgentCard | null => {
		if (isIncomplete) return null;
		try {
			const root = rec(JSON.parse(code));
			const a = rec(root?.agent) ?? root;
			const id = str(a?.id);
			const name = str(a?.name);
			if (!a || !id || !name) return null;
			const trigger = rec(a.triggerConfig);
			const triggerType = (
				typeof a.triggerType === 'string' && a.triggerType in TRIGGER_LABELS
					? a.triggerType
					: 'manual'
			) as AgentTriggerType;
			const event = str(trigger?.event);
			const coding = rec(a.codingTarget);
			return {
				id,
				name,
				description: str(a.description),
				triggerType,
				cron: str(trigger?.cron),
				event: event && event in EVENT_LABELS ? (event as AgentEventName) : null,
				every: num(trigger?.every) ?? 1,
				model: str(a.modelName) ?? str(coding?.model) ?? str(a.modelId),
				tools:
					a.toolAllowlist === null || a.toolAllowlist === undefined
						? null
						: strings(a.toolAllowlist),
				skills: strings(a.skillNames),
				coding: coding ? (str(coding.projectTitle) ?? 'a project') : null,
				enabled: a.enabled !== false,
				nextRunAt: num(a.nextRunAt)
			};
		} catch {
			return null;
		}
	});

	const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
	const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

	function clock(time: string): string {
		const [h, m] = time.split(':').map(Number);
		return timeFmt.format(new Date(2000, 0, 1, h, m));
	}

	/** "0 9 * * 1-5" → "Every weekday at 9:00 AM". */
	function scheduleLabel(cron: string | null): string {
		if (!cron) return 'On a schedule';
		const spec = parseCron(cron);
		if (!spec) return describeCron(cron, 'auto') ?? cron;
		switch (spec.kind) {
			case 'minutes':
				return spec.every === 1 ? 'Every minute' : `Every ${spec.every} minutes`;
			case 'hourly':
				if (spec.every > 1) return `Every ${spec.every} hours`;
				return spec.minute ? `Hourly at :${String(spec.minute).padStart(2, '0')}` : 'Every hour';
			case 'daily':
				return `Every day at ${clock(spec.time)}`;
			case 'monthly':
				return `Monthly on the ${ordinal(spec.day)} at ${clock(spec.time)}`;
			case 'weekly': {
				const days = [...spec.days].sort((a, b) => a - b).join(',');
				const at = clock(spec.time);
				if (days === '1,2,3,4,5') return `Every weekday at ${at}`;
				if (days === '0,6') return `Weekends at ${at}`;
				if (spec.days.length === 1) {
					// 2024-01-07 is a Sunday, so day n of that week is weekday n.
					return `Every ${dayFmt.format(new Date(2024, 0, 7 + spec.days[0]))} at ${at}`;
				}
				return describeCron(cron, 'auto') ?? cron;
			}
		}
	}

	const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
	const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
	const dayStart = (ms: number) => {
		const d = new Date(ms);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	};
	/**
	 * "today at 9:00 AM", "tomorrow at …", "Friday at …", or "Mar 3 at …" further
	 * out. The time is left off when the schedule label already names it.
	 */
	function nextRun(ms: number, withTime: boolean): string {
		const days = Math.round((dayStart(ms) - dayStart(Date.now())) / (24 * 3600_000));
		const day =
			days === 0
				? 'today'
				: days === 1
					? 'tomorrow'
					: days > 0 && days < 6
						? weekdayFmt.format(ms)
						: dateFmt.format(ms);
		return withTime ? `${day} at ${timeFmt.format(ms)}` : day;
	}

	/** Whether the schedule label already says the time ("Every day at 9:00 AM"). */
	function namesTime(a: AgentCard): boolean {
		if (a.triggerType !== 'schedule' || !a.cron) return false;
		const kind = parseCron(a.cron)?.kind;
		return kind === 'daily' || kind === 'weekly' || kind === 'monthly';
	}

	type Trigger = { icon: typeof BotIcon; label: string };
	function trigger(a: AgentCard): Trigger {
		switch (a.triggerType) {
			case 'schedule':
				return { icon: CalendarClockIcon, label: scheduleLabel(a.cron) };
			case 'event': {
				const what = a.event ? EVENT_LABELS[a.event].toLowerCase() : 'an event';
				return {
					icon: ZapIcon,
					label: a.every > 1 ? `Every ${ordinal(a.every)} ${what}` : `On ${what}`
				};
			}
			case 'persona':
				return { icon: MessageCircleIcon, label: 'Chat persona' };
			case 'http':
				return { icon: WebhookIcon, label: 'Via HTTP API' };
			default:
				return { icon: HandIcon, label: 'On demand' };
		}
	}

	const ACRONYMS = new Set(['url', 'api', 'http', 'pr', 'id', 'mcp', 'sql', 'pdf', 'csv']);

	/** "search_chats" / "github__fetch_url" → "Search chats" / "Fetch URL". */
	function toolLabel(name: string): string {
		const words = (name.split('__').pop() ?? name)
			.split(/[_\s-]+/)
			.filter(Boolean)
			.map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
		const label = words.join(' ');
		return label.charAt(0).toUpperCase() + label.slice(1);
	}

	/** Chips shown before "+N": fewer on narrow cards so tools don't take over. */
	const MAX_CHIPS = 5;
	const NARROW_CHIPS = 3;

	/** Agent avatar: a gradient whose hue is stable per name. */
	function hue(name: string): number {
		let h = 0;
		for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
		// Yellow-greens go muddy at this lightness; nudge them towards green.
		return h > 60 && h < 115 ? h + 55 : h;
	}

	// Run now: the same endpoint the Agents page uses.
	type RunState =
		| { kind: 'idle' }
		| { kind: 'pending' }
		| { kind: 'started'; runId: string | null }
		| { kind: 'ignored'; message: string }
		| { kind: 'error'; message: string };
	let run = $state<RunState>({ kind: 'idle' });
	// Briefly hold the button after a start so a double click doesn't queue two runs.
	let cooling = $state(false);

	/** Server messages arrive without a full stop; add one before the follow-up link. */
	const sentence = (msg: string) => (/[.!?]$/.test(msg) ? msg : `${msg}.`);

	async function runNow(id: string) {
		if (run.kind === 'pending' || cooling) return;
		run = { kind: 'pending' };
		try {
			const res = await fetch(`/api/agents/${encodeURIComponent(id)}/run`, { method: 'POST' });
			const body = (await res.json().catch(() => null)) as {
				ignored?: boolean;
				message?: string;
				run?: { id?: string };
			} | null;
			if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
			run = body?.ignored
				? { kind: 'ignored', message: body.message ?? 'Run ignored' }
				: { kind: 'started', runId: body?.run?.id ?? null };
			if (run.kind === 'started') {
				cooling = true;
				setTimeout(() => (cooling = false), 3000);
			}
		} catch (e) {
			run = { kind: 'error', message: e instanceof Error ? e.message : 'Failed to start run' };
		}
	}
</script>

{#snippet more(agentId: string, tools: string[], cls: string)}
	{@const names = tools.map(toolLabel).join(', ')}
	<li class={cls}>
		<a
			href={resolve(`/agents/${agentId}`)}
			class="block rounded-md px-1.5 text-xs leading-5 font-medium text-muted-foreground ring-1 ring-border transition-colors outline-none ring-inset hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			title={names}>+{tools.length}<span class="sr-only"> more tools: {names}</span></a
		>
	</li>
{/snippet}

<WidgetCard
	icon={BotIcon}
	status={agent ? 'ready' : isIncomplete ? 'loading' : 'error'}
	loadingLabel="Setting up agent…"
	errorLabel="Could not show this agent"
	skeletonClass="h-[13.5rem]"
	raw={code}
	class="@container"
>
	{#if agent}
		{@const t = trigger(agent)}
		{@const TriggerIcon = t.icon}
		{@const AvatarIcon = agent.coding
			? CodeXmlIcon
			: agent.triggerType === 'persona'
				? MessageCircleIcon
				: BotIcon}
		{@const h = hue(agent.name)}
		{@const shown = agent.tools?.slice(0, MAX_CHIPS) ?? []}
		{@const hidden = agent.tools?.slice(MAX_CHIPS) ?? []}
		{@const narrowHidden = agent.tools?.slice(NARROW_CHIPS) ?? []}
		{@const agentHref = resolve(`/agents/${agent.id}`)}
		{@const displayName = agentDisplayName(agent.name)}
		{@const showStatus =
			!agent.enabled || agent.triggerType === 'schedule' || agent.triggerType === 'event'}

		<!-- Identity -->
		<div class="flex min-w-0 items-start gap-3 px-4 pt-4 pb-3">
			<div
				class="flex size-10 shrink-0 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-black/5 ring-inset"
				style="background: linear-gradient(140deg, oklch(0.66 0.15 {h}), oklch(0.5 0.17 {(h + 35) %
					360}))"
				aria-hidden="true"
			>
				<AvatarIcon class="size-5" />
			</div>
			<div class="flex min-w-0 flex-1 flex-col gap-0.5">
				<div class="flex min-w-0 items-center gap-2">
					<h3 class="truncate text-base leading-6 font-semibold" title={agent.name}>
						{displayName}
					</h3>
					{#if showStatus}
						<span
							class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 text-xs leading-5 font-medium {agent.enabled
								? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
								: 'bg-muted text-muted-foreground'}"
						>
							<span
								class="size-1.5 rounded-full {agent.enabled
									? 'bg-emerald-500'
									: 'bg-muted-foreground/60'}"
								aria-hidden="true"
							></span>
							{agent.enabled ? 'Active' : 'Paused'}
						</span>
					{/if}
				</div>
				{#if agent.description}
					<p
						class="line-clamp-4 text-sm text-pretty text-muted-foreground @md:line-clamp-2"
						title={agent.description}
					>
						{agent.description}
					</p>
				{/if}
			</div>
		</div>

		<!-- Facts: trigger, model, tools -->
		<dl
			class="mx-4 grid gap-px overflow-hidden rounded-xl bg-border/60 ring-1 ring-border/60 dark:bg-border dark:ring-border"
		>
			<div class="flex min-w-0 items-start gap-3 bg-card px-3 py-2.5">
				<dt class="flex h-5 w-20 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
					<TriggerIcon class="size-3.5 shrink-0" aria-hidden="true" />
					{agent.triggerType === 'schedule' ? 'Schedule' : 'Trigger'}
				</dt>
				<dd class="flex min-w-0 flex-1 flex-col text-sm">
					<span class="font-medium">{t.label}</span>
					{#if !agent.enabled && agent.triggerType !== 'persona'}
						<span class="text-xs text-muted-foreground"
							>Won’t run on its own until you resume it</span
						>
					{:else if agent.nextRunAt}
						<span class="text-xs text-muted-foreground tabular-nums"
							>Next run {nextRun(agent.nextRunAt, !namesTime(agent))}</span
						>
					{/if}
				</dd>
			</div>
			<div class="flex min-w-0 items-start gap-3 bg-card px-3 py-2.5">
				<dt class="flex h-5 w-20 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
					<CpuIcon class="size-3.5 shrink-0" aria-hidden="true" />
					Model
				</dt>
				<dd
					class="min-w-0 flex-1 truncate text-sm {agent.model
						? 'font-medium'
						: 'text-muted-foreground'}"
					title={agent.model ?? undefined}
				>
					{agent.model ?? 'Chat default'}
				</dd>
			</div>
			<div class="flex min-w-0 items-start gap-3 bg-card px-3 py-2.5">
				<dt class="flex h-5 w-20 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
					<WrenchIcon class="size-3.5 shrink-0" aria-hidden="true" />
					Tools
				</dt>
				<dd class="flex min-w-0 flex-1 flex-wrap gap-1">
					{#if agent.coding}
						<span class="text-sm font-medium">Coding task in {agent.coding}</span>
					{:else if agent.tools === null}
						<span class="text-sm font-medium">All tools</span>
					{:else if agent.tools.length === 0}
						<span class="text-sm text-muted-foreground">No tools</span>
					{:else}
						<ul class="contents">
							{#each shown as tool, i (tool)}
								<li
									class="rounded-md bg-muted px-1.5 text-xs leading-5 text-foreground/80 {i >=
									NARROW_CHIPS
										? 'hidden @md:inline-flex'
										: ''}"
									title={tool}
								>
									{toolLabel(tool)}
								</li>
							{/each}
							{#if narrowHidden.length > hidden.length}
								{@render more(agent.id, narrowHidden, '@md:hidden')}
								{#if hidden.length}{@render more(agent.id, hidden, 'hidden @md:block')}{/if}
							{:else if hidden.length}
								{@render more(agent.id, hidden, '')}
							{/if}
						</ul>
					{/if}
					{#if agent.skills.length && !agent.coding}
						<span
							class="{agent.tools?.length
								? 'order-first'
								: ''} inline-flex items-center gap-1 rounded-md bg-violet-500/10 px-1.5 text-xs leading-5 text-violet-700 dark:text-violet-300"
							title={agent.skills.join(', ')}
						>
							<SparklesIcon class="size-3" aria-hidden="true" />
							{agent.skills.length === 1 ? '1 skill' : `${agent.skills.length} skills`}<span
								class="sr-only">: {agent.skills.join(', ')}</span
							>
						</span>
					{/if}
				</dd>
			</div>
		</dl>

		<!-- Actions -->
		<div class="flex flex-wrap items-center gap-x-2 gap-y-2.5 px-4 pt-3 pb-4">
			<Button
				size="sm"
				onclick={() => runNow(agent.id)}
				aria-disabled={run.kind === 'pending' || cooling || undefined}
				aria-busy={run.kind === 'pending' || undefined}
				title={!agent.enabled ? 'Runs once, even while paused' : undefined}
				class="min-w-[7.5rem] justify-center aria-busy:opacity-80 aria-disabled:cursor-default"
				aria-label={`Run now: ${displayName}`}
			>
				{#if run.kind === 'pending'}
					<LoaderCircleIcon class="size-4 animate-spin motion-reduce:animate-none" />
					Starting…
				{:else}
					<PlayIcon class="size-4" />
					Run now
				{/if}
			</Button>
			<Button size="sm" variant="outline" href={agentHref} aria-label={`Open ${displayName}`}>
				Open
				<ChevronRightIcon class="size-4" />
			</Button>
			<span class="sr-only" aria-live="polite"
				>{run.kind === 'started'
					? 'Run started'
					: run.kind === 'ignored'
						? run.message
						: run.kind === 'pending'
							? 'Starting run'
							: ''}</span
			>
			{#if run.kind !== 'idle' && run.kind !== 'pending'}
				<div class="min-w-0 basis-full text-xs @md:flex-1 @md:basis-0">
					{#if run.kind === 'started'}
						<span class="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
							<CircleCheckIcon class="size-3.5 shrink-0" aria-hidden="true" />
							Run started
							{#if run.runId}
								<span aria-hidden="true">·</span>
								<a
									href={resolve(`/agents/${agent.id}/runs/${run.runId}`)}
									class="font-medium underline underline-offset-2 hover:text-foreground">View run</a
								>
							{/if}
						</span>
					{:else if run.kind === 'ignored'}
						<span class="inline-flex items-center gap-1.5 text-muted-foreground">
							<InfoIcon class="size-3.5 shrink-0" aria-hidden="true" />
							{sentence(run.message)}
						</span>
					{:else if run.kind === 'error'}
						<span class="inline-flex items-start gap-1.5 text-destructive" role="alert">
							<CircleAlertIcon class="mt-px size-3.5 shrink-0" aria-hidden="true" />
							<span
								>{sentence(run.message)}
								<a
									href={agentHref}
									class="font-medium whitespace-nowrap underline underline-offset-2 hover:text-foreground"
									>Check agent settings</a
								></span
							>
						</span>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</WidgetCard>
