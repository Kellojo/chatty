<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import {
		buildCron,
		defaultSchedule,
		describeCron,
		HOUR_INTERVALS,
		MINUTE_INTERVALS,
		parseCron,
		WEEKDAYS,
		type ScheduleKind,
		type ScheduleSpec
	} from '$lib/cron.js';
	import type { TimeFormat } from '$lib/user-settings.js';

	let {
		value = $bindable(''),
		timeFormat = '24h',
		readonly = false
	}: {
		/** The cron expression the schedule is saved as. */
		value?: string;
		timeFormat?: TimeFormat;
		readonly?: boolean;
	} = $props();

	type Mode = ScheduleKind | 'custom';

	const MODE_LABELS: Record<Mode, string> = {
		minutes: 'Every few minutes',
		hourly: 'Every few hours',
		daily: 'Every day',
		weekly: 'On certain weekdays',
		monthly: 'Every month',
		custom: 'Custom (cron)'
	};
	const MODES = Object.keys(MODE_LABELS) as Mode[];

	// Schedules open in the picker when it can show them; anything else stays raw cron.
	const initial = parseCron(value);
	let spec = $state<ScheduleSpec>(initial ?? defaultSchedule('daily'));
	let mode = $state<Mode>(initial ? initial.kind : 'custom');

	function update(next: ScheduleSpec) {
		spec = next;
		value = buildCron(next);
	}

	function setMode(next: Mode) {
		if (next === mode) return;
		mode = next;
		if (next === 'custom') return; // keep the current expression to tweak by hand
		// Carry the time of day over when switching between day-based schedules.
		const fresh = defaultSchedule(next);
		if ('time' in fresh && 'time' in spec) fresh.time = spec.time;
		update(fresh);
	}

	function toggleDay(day: number) {
		if (spec.kind !== 'weekly') return;
		const days = spec.days.includes(day) ? spec.days.filter((d) => d !== day) : [...spec.days, day];
		if (days.length === 0) return; // at least one day keeps the schedule valid
		update({ ...spec, days });
	}

	function clampInt(raw: string | number, min: number, max: number, fallback: number) {
		const n = Math.round(Number(raw));
		return Number.isFinite(n) && String(raw).trim() !== ''
			? Math.min(max, Math.max(min, n))
			: fallback;
	}

	const summary = $derived(value.trim() ? describeCron(value.trim(), timeFormat) : null);
	const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
</script>

<SettingsRow label="Repeats" stack>
	<Select.Root
		type="single"
		value={mode}
		onValueChange={(v) => setMode(v as Mode)}
		disabled={readonly}
	>
		<Select.Trigger class="w-full sm:w-56" aria-label="Repeats">{MODE_LABELS[mode]}</Select.Trigger>
		<Select.Content>
			{#each MODES as option (option)}
				<Select.Item value={option}>{MODE_LABELS[option]}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>
</SettingsRow>

{#if mode === 'custom'}
	<SettingsRow
		label="Cron expression"
		for="agent-cron"
		description="Five fields: minute, hour, day of month, month, weekday. E.g. 0 9 * * 1-5 for weekdays at 9:00."
		stack
	>
		<Input
			id="agent-cron"
			bind:value
			{readonly}
			required
			placeholder="0 9 * * 1-5"
			class="w-full font-mono text-sm sm:w-56"
		/>
	</SettingsRow>
{:else if spec.kind === 'minutes'}
	<SettingsRow label="Every" stack>
		<Select.Root
			type="single"
			value={String(spec.every)}
			onValueChange={(v) => update({ kind: 'minutes', every: Number(v) })}
			disabled={readonly}
		>
			<Select.Trigger class="w-full sm:w-56" aria-label="Minute interval">
				{unit(spec.every, 'minute')}
			</Select.Trigger>
			<Select.Content>
				{#each MINUTE_INTERVALS as n (n)}
					<Select.Item value={String(n)}>{unit(n, 'minute')}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</SettingsRow>
{:else if spec.kind === 'hourly'}
	{@const hourly = spec}
	<SettingsRow label="Every" stack>
		<Select.Root
			type="single"
			value={String(hourly.every)}
			onValueChange={(v) => update({ ...hourly, every: Number(v) })}
			disabled={readonly}
		>
			<Select.Trigger class="w-full sm:w-56" aria-label="Hour interval">
				{unit(hourly.every, 'hour')}
			</Select.Trigger>
			<Select.Content>
				{#each HOUR_INTERVALS as n (n)}
					<Select.Item value={String(n)}>{unit(n, 'hour')}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</SettingsRow>
	<SettingsRow
		label="At minute"
		for="agent-cron-minute"
		description="Minutes past the hour, 0 to 59."
		stack
	>
		<Input
			id="agent-cron-minute"
			type="number"
			min={0}
			max={59}
			value={hourly.minute}
			onchange={(e) =>
				update({
					...hourly,
					minute: clampInt(e.currentTarget.value, 0, 59, hourly.minute)
				})}
			{readonly}
			class="w-full sm:w-28"
		/>
	</SettingsRow>
{:else}
	{@const timed = spec}
	{#if timed.kind === 'weekly'}
		<SettingsRow label="On" stack>
			<div class="flex w-full flex-wrap gap-1 sm:w-auto" role="group" aria-label="Weekdays">
				{#each WEEKDAYS as day (day.value)}
					{@const on = timed.days.includes(day.value)}
					<button
						type="button"
						aria-pressed={on}
						disabled={readonly}
						class="h-9 min-w-11 flex-1 rounded-md border px-2 text-sm transition-colors disabled:opacity-60 sm:flex-none md:h-8 {on
							? 'border-primary bg-primary text-primary-foreground'
							: 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
						onclick={() => toggleDay(day.value)}
					>
						{day.short}
					</button>
				{/each}
			</div>
		</SettingsRow>
	{:else if timed.kind === 'monthly'}
		<SettingsRow
			label="On day"
			for="agent-cron-day"
			description={timed.day > 28 ? 'Months without this day are skipped.' : 'Day of the month.'}
			stack
		>
			<Input
				id="agent-cron-day"
				type="number"
				min={1}
				max={31}
				value={timed.day}
				onchange={(e) =>
					update({ ...timed, day: clampInt(e.currentTarget.value, 1, 31, timed.day) })}
				{readonly}
				class="w-full sm:w-28"
			/>
		</SettingsRow>
	{/if}
	<SettingsRow label="At" for="agent-cron-time" description="In the server's time zone." stack>
		<Input
			id="agent-cron-time"
			type="time"
			value={timed.time}
			onchange={(e) => {
				if (e.currentTarget.value) update({ ...timed, time: e.currentTarget.value });
			}}
			{readonly}
			required
			class="w-full sm:w-36"
		/>
	</SettingsRow>
{/if}

{#if summary || mode === 'custom'}
	<p class="text-sm text-muted-foreground">
		{#if summary}
			Runs: <span class="text-foreground">{summary}</span>
		{:else}
			Not a valid cron expression yet.
		{/if}
	</p>
{/if}
