<script lang="ts">
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import DailyStackedChart from '$lib/components/app/usage/DailyStackedChart.svelte';
	import { formatDayLong } from '$lib/components/app/usage/usage.js';
	import { formatTimeAgo } from '$lib/datetime.js';
	import { formatWholeCountTick } from '$lib/formats.js';
	import { skillPath } from '$lib/skill-labels.js';
	import { SKILL_TRIGGERS, type SkillSummary, type SkillUsageDetail } from '$lib/skill-types.js';
	import { percent, plural, TRIGGER_INFO } from './skill-usage.js';

	let {
		open = $bindable(false),
		skill,
		detail,
		everyone,
		lastUsedAt = null,
		onDisable
	}: {
		open?: boolean;
		skill: SkillSummary | null;
		/** Null while loading. */
		detail: SkillUsageDetail | null;
		/** Counts every user's uses (an admin on a shared skill), not only the viewer's. */
		everyone: boolean;
		/** Latest use ever, for a skill idle in the window. */
		lastUsedAt?: number | null;
		/** Turns the skill off (true once saved); offered when it went unused. Absent: not allowed, or already off. */
		onDisable?: () => Promise<boolean>;
	} = $props();

	let content = $state<HTMLElement | null>(null);
	let disabling = $state(false);

	async function disable() {
		if (!onDisable) return;
		disabling = true;
		try {
			if (await onDisable()) open = false;
		} finally {
			disabling = false;
		}
	}

	const total = $derived(SKILL_TRIGGERS.reduce((n, t) => n + (detail?.uses[t] ?? 0), 0));
	const busiest = $derived(
		(detail?.daily ?? []).reduce<{ day: string; uses: number } | null>((best, d) => {
			const uses = SKILL_TRIGGERS.reduce((n, t) => n + d[t], 0);
			return uses > (best?.uses ?? 0) ? { day: d.day, uses } : best;
		}, null)
	);
	const chartSummary = $derived(
		busiest
			? `${plural(total, 'use')} in the last ${detail?.days} days; busiest day ${formatDayLong(busiest.day)} with ${plural(busiest.uses, 'use')}.`
			: ''
	);
	const series = SKILL_TRIGGERS.map((t) => ({
		key: t,
		label: TRIGGER_INFO[t].label,
		color: TRIGGER_INFO[t].color
	}));
	const rows = $derived((detail?.daily ?? []).map((d) => ({ ...d })));

	const DAY_MS = 86_400_000;
	/** "45 days ago (Sep 29, 2026)": the gap is what matters when deciding to drop a skill. */
	function lastUsedText(at: number): string {
		const days = Math.floor((Date.now() - at) / DAY_MS);
		const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(at);
		return days >= 2 ? `${days} days ago (${date})` : formatTimeAgo(at);
	}

	/** Dividers of the stat grid: 2x2 on phones, one row of 4 from `sm`. */
	const cellBorders = (i: number) =>
		[i % 2 && 'border-l', i >= 2 && 'max-sm:border-t', i === 2 && 'sm:border-l']
			.filter(Boolean)
			.join(' ');
	const bone = (size: string) =>
		`animate-pulse rounded bg-foreground/8 motion-reduce:animate-none ${size}`;

	const stats = $derived([
		{ label: 'Uses', value: total.toLocaleString(), hint: undefined },
		...SKILL_TRIGGERS.map((t) => ({
			label: TRIGGER_INFO[t].label,
			value: (detail?.uses[t] ?? 0).toLocaleString(),
			hint: `${TRIGGER_INFO[t].description} · ${percent(detail?.uses[t] ?? 0, total)} of uses`
		}))
	]);
</script>

<Dialog.Root bind:open>
	<!-- Focus the dialog itself on open: the first tabbable is the footer's Close, whose
	     focus ring would otherwise greet every mouse open. -->
	<Dialog.Content
		bind:ref={content}
		tabindex={-1}
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			content?.focus();
		}}
		class="flex max-h-[92dvh] flex-col gap-5 sm:max-h-[85dvh] sm:max-w-xl"
	>
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="truncate pr-8 leading-normal font-semibold"
				>{skill?.title ?? ''} usage</Dialog.Title
			>
			<Dialog.Description>
				{everyone ? 'Uses by all users' : 'Your uses'} in the last {detail?.days ?? 30} days{everyone &&
				detail
					? ` · ${plural(detail.users, 'user')}`
					: ''}.
			</Dialog.Description>
		</Dialog.Header>

		{#if !detail}
			<!-- The loaded layout's shape, so the dialog doesn't jump when data arrives. -->
			<div class="flex flex-col gap-6" role="status" aria-label="Loading usage">
				<div class="grid grid-cols-2 overflow-hidden rounded-xl border sm:grid-cols-4">
					{#each [0, 1, 2, 3] as i (i)}
						<div class="flex flex-col gap-2 px-4 py-3 {cellBorders(i)}">
							<div class={bone('h-3 w-12')}></div>
							<div class={bone('h-6 w-16')}></div>
						</div>
					{/each}
				</div>
				<div class="flex flex-col gap-2">
					<div class={bone('h-5 w-28')}></div>
					<div class={bone('h-28 rounded-xl sm:h-36')}></div>
					<div class={bone('mt-0.5 h-4 w-40 self-center')}></div>
				</div>
			</div>
		{:else if total === 0}
			<div class="flex flex-col items-center gap-3 px-6 py-6 text-center">
				<div
					class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
				>
					<ChartColumnIcon class="size-5" />
				</div>
				<div class="flex flex-col gap-1">
					<p class="text-sm font-medium">
						{lastUsedAt ? `Not used in the last ${detail.days} days` : 'Never used'}
					</p>
					<p class="text-sm text-balance text-muted-foreground">
						{lastUsedAt
							? `Last used ${lastUsedText(lastUsedAt)}.`
							: 'No chat or agent run has loaded it yet.'}
					</p>
					{#if onDisable}
						<p class="text-sm text-balance text-muted-foreground">
							If nobody needs it, consider turning it off so the model stops weighing it.
						</p>
					{/if}
				</div>
			</div>
		{:else}
			<div class="flex min-h-0 flex-col gap-6">
				<dl class="grid shrink-0 grid-cols-2 overflow-hidden rounded-xl border sm:grid-cols-4">
					{#each stats as s, i (s.label)}
						<div class="flex flex-col gap-0.5 px-4 py-3 {cellBorders(i)}" title={s.hint}>
							<dt class="truncate text-xs text-muted-foreground">{s.label}</dt>
							<dd class="text-xl font-semibold tabular-nums">{s.value}</dd>
						</div>
					{/each}
				</dl>

				<section class="flex shrink-0 flex-col gap-2" aria-labelledby="skill-usage-daily">
					<h3 id="skill-usage-daily" class="text-sm font-medium">Uses per day</h3>
					<DailyStackedChart
						{rows}
						{series}
						valueFormat={(v) => v.toLocaleString()}
						axisFormat={formatWholeCountTick}
						summary={chartSummary}
						class="max-h-28 min-h-28 sm:max-h-36 sm:min-h-36"
					/>
				</section>
			</div>
		{/if}

		<Dialog.Footer class="shrink-0">
			<Button variant="outline" onclick={() => (open = false)}>Close</Button>
			{#if detail && total === 0 && onDisable}
				<Button onclick={disable} disabled={disabling}>
					{disabling ? 'Turning off…' : 'Turn off skill'}
				</Button>
			{:else if skill && total > 0}
				<Button variant="outline" href={resolve(skillPath(skill))}>See recent uses</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
