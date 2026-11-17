<script lang="ts">
	import ClockIcon from '@lucide/svelte/icons/clock';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import {
		buildCron,
		describeCron,
		describeSchedule,
		HOUR_INTERVALS,
		MINUTE_INTERVALS,
		ordinal,
		parseCron,
		WEEKDAYS,
		type ScheduleSpec
	} from '$lib/cron.js';
	import type { TimeFormat } from '$lib/user-settings.js';

	let {
		value = $bindable(''),
		timeFormat = '24h',
		timeZone = 'UTC',
		readonly = false
	}: {
		/** The cron expression the schedule is saved as. */
		value?: string;
		timeFormat?: TimeFormat;
		/** IANA zone the scheduler runs in, shown next to the time. */
		timeZone?: string;
		readonly?: boolean;
	} = $props();

	/**
	 * Four modes instead of one per cron shape: "Interval" covers minutes and hours,
	 * "Daily" covers every day and picked weekdays (all days on = every day).
	 */
	type Mode = 'interval' | 'daily' | 'monthly' | 'custom';

	const MODE_OPTIONS: { value: Mode; label: string }[] = [
		{ value: 'interval', label: 'Interval' },
		{ value: 'daily', label: 'Daily' },
		{ value: 'monthly', label: 'Monthly' },
		{ value: 'custom', label: 'Custom' }
	];

	const ALL_DAYS = WEEKDAYS.map((d) => d.value as number);

	function modeOf(s: ScheduleSpec): Mode {
		if (s.kind === 'minutes' || s.kind === 'hourly') return 'interval';
		if (s.kind === 'monthly') return 'monthly';
		return 'daily';
	}

	// Schedules open in the picker when it can show them; anything else stays raw cron.
	const initial = parseCron(value);
	let spec = $state<ScheduleSpec>(initial ?? { kind: 'daily', time: '09:00' });
	let mode = $state<Mode>(initial ? modeOf(initial) : 'custom');

	function update(next: ScheduleSpec) {
		// A weekly schedule with every day picked is just a daily one.
		if (next.kind === 'weekly' && next.days.length === 7) next = { kind: 'daily', time: next.time };
		spec = next;
		value = buildCron(next);
	}

	function timeOf(s: ScheduleSpec): string {
		return 'time' in s ? s.time : '09:00';
	}

	function setMode(next: Mode) {
		if (next === mode || readonly) return;
		mode = next;
		if (next === 'custom') return; // keep the current expression to tweak by hand
		if (next === 'interval') update({ kind: 'hourly', every: 1, minute: 0 });
		else if (next === 'daily') update({ kind: 'daily', time: timeOf(spec) });
		else update({ kind: 'monthly', day: 1, time: timeOf(spec) });
	}

	let modeButtons = $state<HTMLButtonElement[]>([]);

	/** Arrow keys move and select within the radio group, like native radios. */
	function onModeKey(event: KeyboardEvent, index: number) {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const next = (index + step + MODE_OPTIONS.length) % MODE_OPTIONS.length;
		setMode(MODE_OPTIONS[next].value);
		modeButtons[next]?.focus();
	}

	// Daily mode works on a day list; "daily" means all seven.
	const days = $derived(spec.kind === 'weekly' ? spec.days : spec.kind === 'daily' ? ALL_DAYS : []);

	function setDays(next: number[]) {
		if (next.length === 0) return; // at least one day keeps the schedule valid
		update({ kind: 'weekly', days: next, time: timeOf(spec) });
	}

	function toggleDay(day: number) {
		setDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day]);
	}

	const sameDays = (a: number[], b: number[]) =>
		a.length === b.length && a.every((d) => b.includes(d));

	const DAY_PRESETS = [
		{ label: 'Every day', days: ALL_DAYS },
		{ label: 'Weekdays', days: [1, 2, 3, 4, 5] },
		{ label: 'Weekends', days: [6, 0] }
	];

	// One list for minutes and hours, so an interval is a single choice.
	const INTERVALS = [
		...MINUTE_INTERVALS.map((n) => ({ key: `m${n}`, kind: 'minutes' as const, n })),
		...HOUR_INTERVALS.map((n) => ({ key: `h${n}`, kind: 'hourly' as const, n }))
	];
	const intervalKey = $derived(
		spec.kind === 'minutes' ? `m${spec.every}` : spec.kind === 'hourly' ? `h${spec.every}` : ''
	);
	const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const intervalLabel = (i: (typeof INTERVALS)[number]) =>
		unit(i.n, i.kind === 'minutes' ? 'minute' : 'hour');

	function setInterval(key: string) {
		const i = INTERVALS.find((x) => x.key === key);
		if (!i) return;
		const minute = spec.kind === 'hourly' ? spec.minute : 0;
		update(
			i.kind === 'minutes'
				? { kind: 'minutes', every: i.n }
				: { kind: 'hourly', every: i.n, minute }
		);
	}

	const pad = (n: number) => String(n).padStart(2, '0');
	const HOURS = Array.from({ length: 24 }, (_, h) => h);
	const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
	const twelveHour = $derived(timeFormat !== '24h');
	const hourLabel = (h: number) =>
		twelveHour ? `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` : pad(h);

	const minuteLabel = (m: number) => (m === 0 ? 'on the hour' : `${m} min past`);

	/** Five-minute steps, plus the saved minute when a hand-written cron used another one. */
	function minuteOptions(current: number): number[] {
		const steps = Array.from({ length: 12 }, (_, i) => i * 5);
		return steps.includes(current) ? steps : [...steps, current].sort((a, b) => a - b);
	}

	const clock = $derived.by(() => {
		const [h, m] = timeOf(spec).split(':').map(Number);
		return { h, m };
	});

	function setClock(h: number, m: number) {
		if ('time' in spec) update({ ...spec, time: `${pad(h)}:${pad(m)}` });
	}

	const trimmed = $derived(value.trim());
	const fieldCount = $derived(trimmed ? trimmed.split(/\s+/).length : 0);
	const summary = $derived.by(() => {
		if (mode !== 'custom') return describeSchedule(spec, timeFormat);
		const text = describeCron(trimmed, timeFormat);
		return text && text.charAt(0).toLowerCase() + text.slice(1);
	});
	const cronError = $derived(
		mode !== 'custom' || summary
			? null
			: !trimmed
				? 'Enter a cron expression.'
				: fieldCount !== 5
					? `Expected 5 fields, got ${fieldCount}.`
					: 'One of the fields is not valid.'
	);
</script>

<SettingsRow label="Repeats" stack>
	<div
		class="grid w-full grid-cols-4 rounded-lg border p-0.5 sm:inline-grid sm:w-auto"
		role="radiogroup"
		aria-label="Repeats"
	>
		{#each MODE_OPTIONS as option, index (option.value)}
			{@const checked = mode === option.value}
			<button
				bind:this={modeButtons[index]}
				type="button"
				role="radio"
				aria-checked={checked}
				tabindex={checked ? 0 : -1}
				disabled={readonly && !checked}
				class="flex h-9 items-center justify-center rounded-md px-3 text-sm transition-colors disabled:opacity-50 sm:min-w-20 md:h-8 {checked
					? 'bg-accent font-medium text-accent-foreground'
					: 'text-muted-foreground hover:text-foreground'}"
				onclick={() => setMode(option.value)}
				onkeydown={(e) => onModeKey(e, index)}
			>
				{option.label}
			</button>
		{/each}
	</div>
</SettingsRow>

{#if mode === 'custom'}
	<SettingsRow
		label="Cron expression"
		for="agent-cron"
		description={readonly
			? 'Minute, hour, day, month, weekday.'
			: 'Minute, hour, day, month, weekday. E.g. 0 9 * * 1-5.'}
		stack
	>
		<div class="flex w-full flex-col gap-1.5 sm:w-56">
			<Input
				id="agent-cron"
				bind:value
				{readonly}
				required
				placeholder="0 9 * * 1-5"
				aria-invalid={cronError ? true : undefined}
				aria-describedby={cronError ? 'agent-cron-error' : undefined}
				class="w-full font-mono text-sm"
			/>
			{#if cronError}
				<p id="agent-cron-error" class="px-3 text-xs text-destructive" aria-live="polite">
					{cronError}
				</p>
			{/if}
		</div>
	</SettingsRow>
{:else if mode === 'interval'}
	<SettingsRow label="Every" stack>
		<div class="flex w-full items-center gap-2 sm:w-auto">
			<Select.Root
				type="single"
				value={intervalKey}
				onValueChange={setInterval}
				disabled={readonly}
			>
				<Select.Trigger class="min-w-0 flex-1 sm:w-36 sm:flex-none" aria-label="Interval">
					{intervalLabel(INTERVALS.find((i) => i.key === intervalKey) ?? INTERVALS[0])}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						<Select.GroupHeading>Minutes</Select.GroupHeading>
						{#each INTERVALS.filter((i) => i.kind === 'minutes') as i (i.key)}
							<Select.Item value={i.key}>{intervalLabel(i)}</Select.Item>
						{/each}
					</Select.Group>
					<Select.Group>
						<Select.GroupHeading>Hours</Select.GroupHeading>
						{#each INTERVALS.filter((i) => i.kind === 'hourly') as i (i.key)}
							<Select.Item value={i.key}>{intervalLabel(i)}</Select.Item>
						{/each}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			{#if spec.kind === 'hourly'}
				{@const hourly = spec}
				<Select.Root
					type="single"
					value={String(hourly.minute)}
					onValueChange={(v) => update({ ...hourly, minute: Number(v) })}
					disabled={readonly}
				>
					<Select.Trigger
						class="min-w-0 flex-1 sm:w-36 sm:flex-none"
						aria-label="Minutes past the hour"
					>
						{minuteLabel(hourly.minute)}
					</Select.Trigger>
					<Select.Content>
						{#each minuteOptions(hourly.minute) as m (m)}
							<Select.Item value={String(m)}>{minuteLabel(m)}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{/if}
		</div>
	</SettingsRow>
{:else}
	{#if mode === 'daily'}
		<SettingsRow label="On" stack class="sm:items-start sm:[&>div:first-child]:pt-2">
			<div class="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
				<div
					class="grid w-full grid-cols-7 gap-1 sm:inline-grid sm:w-auto"
					role="group"
					aria-label="Weekdays"
				>
					{#each WEEKDAYS as day (day.value)}
						{@const on = days.includes(day.value)}
						{@const lone = on && days.length === 1}
						<button
							type="button"
							aria-pressed={on}
							aria-disabled={lone || undefined}
							title={lone && !readonly ? 'At least one day stays selected' : undefined}
							disabled={readonly}
							class="h-9 rounded-md border px-2 text-sm transition-colors disabled:cursor-default aria-disabled:cursor-not-allowed sm:min-w-11 md:h-8 {on
								? 'border-primary bg-primary font-medium text-primary-foreground'
								: 'bg-background text-foreground hover:bg-muted disabled:text-muted-foreground'}"
							onclick={() => toggleDay(day.value)}
						>
							{day.short}
						</button>
					{/each}
				</div>
				{#if !readonly}
					<div class="flex flex-wrap gap-1.5" role="group" aria-label="Quick pick">
						{#each DAY_PRESETS as preset (preset.label)}
							{@const active = sameDays(days, preset.days)}
							<button
								type="button"
								aria-pressed={active}
								class="h-7 rounded-full border px-3 text-xs transition-colors {active
									? 'border-foreground/30 bg-muted font-medium text-foreground'
									: 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
								onclick={() => setDays(preset.days)}
							>
								{preset.label}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</SettingsRow>
	{:else if spec.kind === 'monthly'}
		{@const monthly = spec}
		<SettingsRow
			label="On day"
			description={monthly.day > 28 ? 'Months without this day are skipped.' : undefined}
			stack
		>
			<Select.Root
				type="single"
				value={String(monthly.day)}
				onValueChange={(v) => update({ ...monthly, day: Number(v) })}
				disabled={readonly}
			>
				<Select.Trigger class="w-full sm:w-36" aria-label="Day of the month">
					{ordinal(monthly.day)}
				</Select.Trigger>
				<Select.Content class="max-h-72">
					{#each MONTH_DAYS as d (d)}
						<Select.Item value={String(d)}>{ordinal(d)}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</SettingsRow>
	{/if}
	<SettingsRow label="At" stack>
		<div class="flex w-full items-center gap-2 sm:w-auto" role="group" aria-label="Time of day">
			<Select.Root
				type="single"
				value={String(clock.h)}
				onValueChange={(v) => setClock(Number(v), clock.m)}
				disabled={readonly}
			>
				<Select.Trigger class="min-w-0 flex-1 sm:w-24 sm:flex-none" aria-label="Hour">
					{hourLabel(clock.h)}
				</Select.Trigger>
				<Select.Content class="max-h-72">
					{#each HOURS as h (h)}
						<Select.Item value={String(h)}>{hourLabel(h)}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<span class="text-muted-foreground" aria-hidden="true">:</span>
			<Select.Root
				type="single"
				value={String(clock.m)}
				onValueChange={(v) => setClock(clock.h, Number(v))}
				disabled={readonly}
			>
				<Select.Trigger class="min-w-0 flex-1 sm:w-20 sm:flex-none" aria-label="Minute">
					{pad(clock.m)}
				</Select.Trigger>
				<Select.Content class="max-h-72">
					{#each minuteOptions(clock.m) as m (m)}
						<Select.Item value={String(m)}>{pad(m)}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
	</SettingsRow>
{/if}

{#if !cronError}
	<p
		class="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
		aria-live="polite"
	>
		<ClockIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<span class="flex flex-wrap gap-x-2">
			<span>Runs <span class="font-medium text-foreground">{summary}</span></span>
			<span class="whitespace-nowrap text-muted-foreground/80">{timeZone}</span>
		</span>
	</p>
{/if}
