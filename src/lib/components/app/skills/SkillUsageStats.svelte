<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import DailyStackedChart from '$lib/components/app/usage/DailyStackedChart.svelte';
	import SegmentedToggle from '$lib/components/app/SegmentedToggle.svelte';
	import { modelColors, USAGE_PERIODS, type UsagePeriod } from '$lib/components/app/usage/usage.js';
	import { formatTimeAgo } from '$lib/datetime.js';
	import { formatWholeCountTick } from '$lib/formats.js';
	import {
		skillUsageKey,
		type SkillSummary,
		type SkillUsage,
		type SkillUsageStats
	} from '$lib/skill-types.js';
	import { percent, TRIGGER_INFO } from './skill-usage.js';

	let {
		stats,
		period,
		skills,
		usage,
		everyone,
		onPeriodChange,
		onShowSkill
	}: {
		stats: SkillUsageStats;
		period: UsagePeriod;
		/** Every skill the viewer has (theirs, and the shared ones they don't override). */
		skills: SkillSummary[];
		/** All-time last use per skill usage key, for skills idle in this period. */
		usage: Record<string, SkillUsage>;
		/** Shared skills count every user's uses (admins), not only the viewer's. */
		everyone: boolean;
		onPeriodChange: (period: UsagePeriod) => void;
		/** Opens a skill's usage breakdown. */
		onShowSkill: (skill: SkillSummary) => void;
	} = $props();

	const byKey = $derived(new Map(skills.map((s) => [skillUsageKey(s), s])));
	// Colors follow the skill, so it keeps its color across periods.
	const colors = $derived(
		modelColors(
			stats.skills.map((s) => s.key),
			skills.map(skillUsageKey)
		)
	);

	// Chart series keys end up in CSS variable names, so they get plain ids instead of `scope:name`.
	const series = $derived(
		stats.skills.map((s, i) => ({
			key: `s${i}`,
			label: byKey.get(s.key)?.title ?? s.name,
			color: colors[s.key]
		}))
	);
	const chartRows = $derived(
		stats.daily.map((d) => {
			const row: Record<string, string | number> = { day: d.day };
			stats.skills.forEach((s, i) => (row[`s${i}`] = d.uses[s.key] ?? 0));
			return row;
		})
	);

	const totals = $derived(
		stats.skills.reduce(
			(sum, s) => ({ uses: sum.uses + s.uses, auto: sum.auto + s.auto + s.agent }),
			{ uses: 0, auto: 0 }
		)
	);
	const enabledSkills = $derived(skills.filter((s) => s.enabled));
	const usedKeys = $derived(new Set(stats.skills.map((s) => s.key)));
	// Enabled but never loaded in this period: the candidates for turning off.
	const idle = $derived(enabledSkills.filter((s) => !usedKeys.has(skillUsageKey(s))));
	const usedEnabled = $derived(enabledSkills.filter((s) => usedKeys.has(skillUsageKey(s))).length);

	const tiles = $derived([
		{ label: 'Uses', value: totals.uses.toLocaleString() },
		// Uses the model chose itself, in a chat or an agent run, rather than a person picking it.
		{ label: 'Loaded automatically', value: percent(totals.auto, totals.uses) },
		everyone
			? { label: 'Users', value: stats.users.toLocaleString() }
			: {
					label: 'Picked by hand',
					value: stats.skills.reduce((n, s) => n + s.manual, 0).toLocaleString()
				},
		{ label: 'Skills used', value: `${usedEnabled} of ${enabledSkills.length}` }
	]);
</script>

<div class="flex flex-col gap-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<p class="text-sm text-muted-foreground">
			{everyone
				? 'Your skills’ uses, and shared skills’ uses by all users,'
				: 'Skills loaded in your chats and agent runs'} over the last {stats.days} days.
		</p>
		<SegmentedToggle
			label="Period"
			options={USAGE_PERIODS.map((p) => ({ value: p, label: p }))}
			value={period}
			onChange={onPeriodChange}
		/>
	</div>

	<dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		{#each tiles as tile (tile.label)}
			<Card.Root class="rounded-2xl border-border/40 py-4">
				<Card.Content class="flex flex-col gap-1 px-4">
					<dt class="truncate text-sm text-muted-foreground">{tile.label}</dt>
					<dd class="text-2xl font-semibold tabular-nums">{tile.value}</dd>
				</Card.Content>
			</Card.Root>
		{/each}
	</dl>

	<section class="flex flex-col gap-3" aria-labelledby="skill-daily-heading">
		<h2 id="skill-daily-heading" class="text-base font-semibold">Uses per day</h2>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content>
				<DailyStackedChart
					rows={chartRows}
					{series}
					valueFormat={(v) => v.toLocaleString()}
					axisFormat={formatWholeCountTick}
					emptyText="No skill was loaded in this period."
				/>
			</Card.Content>
		</Card.Root>
	</section>

	<section class="flex flex-col gap-3" aria-labelledby="skill-table-heading">
		<div class="flex flex-col gap-1">
			<h2 id="skill-table-heading" class="text-base font-semibold">By skill</h2>
			<p class="text-sm text-muted-foreground">
				Enabled skills nobody used in this period are listed last. Select one to see its uses per
				day.
			</p>
		</div>
		<Card.Root class="rounded-2xl border-border/40">
			<Card.Content>
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Skill</Table.Head>
							<Table.Head class="text-right">Uses</Table.Head>
							<Table.Head class="hidden text-right sm:table-cell">Share</Table.Head>
							<Table.Head
								class="hidden text-right md:table-cell"
								title={TRIGGER_INFO.manual.description}>{TRIGGER_INFO.manual.short}</Table.Head
							>
							<Table.Head
								class="hidden text-right md:table-cell"
								title={TRIGGER_INFO.auto.description}>{TRIGGER_INFO.auto.short}</Table.Head
							>
							<Table.Head
								class="hidden text-right md:table-cell"
								title={TRIGGER_INFO.agent.description}>{TRIGGER_INFO.agent.short}</Table.Head
							>
							{#if everyone}
								<Table.Head class="hidden text-right lg:table-cell">Users</Table.Head>
							{/if}
							<Table.Head class="text-right">Last used</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each stats.skills as s (s.key)}
							{@const skill = byKey.get(s.key)}
							<Table.Row>
								<Table.Cell class="max-w-48">
									<span class="flex min-w-0 items-center gap-2">
										<span
											class="size-2 shrink-0 rounded-full"
											style:background-color={colors[s.key]}
										></span>
										{#if skill}
											<button
												type="button"
												class="truncate rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
												title={skill.name}
												onclick={() => onShowSkill(skill)}>{skill.title}</button
											>
											{#if !skill.enabled}
												<Badge variant="outline" class="text-muted-foreground">Off</Badge>
											{/if}
										{:else}
											<!-- Deleted, renamed, or a shared skill now replaced by one of the viewer's. -->
											<span
												class="truncate font-mono text-muted-foreground"
												title="No longer listed">{s.name}</span
											>
										{/if}
									</span>
								</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{s.uses.toLocaleString()}</Table.Cell>
								<Table.Cell
									class="hidden text-right text-muted-foreground tabular-nums sm:table-cell"
								>
									{percent(s.uses, totals.uses)}
								</Table.Cell>
								{#each [s.manual, s.auto, s.agent] as n, i (i)}
									<Table.Cell
										class="hidden text-right text-muted-foreground tabular-nums md:table-cell"
									>
										{n ? n.toLocaleString() : '—'}
									</Table.Cell>
								{/each}
								{#if everyone}
									<Table.Cell
										class="hidden text-right text-muted-foreground tabular-nums lg:table-cell"
									>
										{s.users}
									</Table.Cell>
								{/if}
								<Table.Cell class="text-right whitespace-nowrap text-muted-foreground">
									{formatTimeAgo(s.lastUsedAt)}
								</Table.Cell>
							</Table.Row>
						{/each}
						{#each idle as skill (skillUsageKey(skill))}
							{@const last = usage[skillUsageKey(skill)]?.lastUsedAt}
							<Table.Row class="text-muted-foreground">
								<Table.Cell class="max-w-48">
									<span class="flex min-w-0 items-center gap-2">
										<span class="size-2 shrink-0 rounded-full bg-border"></span>
										<button
											type="button"
											class="truncate rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
											title={skill.name}
											onclick={() => onShowSkill(skill)}>{skill.title}</button
										>
										<Badge variant="outline" class="text-muted-foreground">Unused</Badge>
									</span>
								</Table.Cell>
								<Table.Cell class="text-right tabular-nums">0</Table.Cell>
								<Table.Cell class="hidden text-right sm:table-cell">—</Table.Cell>
								<Table.Cell class="hidden text-right md:table-cell">—</Table.Cell>
								<Table.Cell class="hidden text-right md:table-cell">—</Table.Cell>
								<Table.Cell class="hidden text-right md:table-cell">—</Table.Cell>
								{#if everyone}
									<Table.Cell class="hidden text-right lg:table-cell">—</Table.Cell>
								{/if}
								<Table.Cell class="text-right whitespace-nowrap">
									{last ? formatTimeAgo(last) : 'Never'}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	</section>
</div>
