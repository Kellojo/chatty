<script lang="ts">
	type DailyCount = { day: string; count: number; completed: number; failed: number };

	type Props = {
		data: DailyCount[];
	};

	let { data }: Props = $props();

	interface Cell {
		day: string;
		month: number;
		dateNum: number;
		count: number;
		failed: number;
		level: number;
	}

	let containerWidth = $state(0);

	// 14px cell + 3px gap per week column, ~32px for day-of-week labels
	const CELL_STEP = 17;
	const LABEL_WIDTH = 32;
	const visibleWeeks = $derived(
		Math.max(4, Math.floor((containerWidth - LABEL_WIDTH) / CELL_STEP))
	);

	const countMap = $derived(new Map(data.map((d) => [d.day, d])));

	function buildCells(weekCount: number): (Cell | null)[][] {
		const DAY_MS = 86400000;
		const totalDays = weekCount * 7;

		const today = new Date();
		const todayMs = today.getTime();
		const dow = today.getDay();
		// Align end to Sunday of current week
		const endPad = dow === 0 ? 0 : 7 - dow;
		const startMs = todayMs - (totalDays - 1 - endPad) * DAY_MS;

		const maxCount = Math.max(1, ...data.map((d) => d.count));

		const weeks: (Cell | null)[][] = [];
		for (let w = 0; w < weekCount; w++) {
			const week: (Cell | null)[] = [];
			for (let d = 0; d < 7; d++) {
				const ms = startMs + (w * 7 + d) * DAY_MS;
				if (ms > todayMs + DAY_MS) {
					week.push(null);
					continue;
				}

				const dt = new Date(ms);
				const day = dt.toISOString().slice(0, 10);
				const entry = countMap.get(day);
				const count = entry?.count ?? 0;
				week.push({
					day,
					month: dt.getMonth(),
					dateNum: dt.getDate(),
					count,
					failed: entry?.failed ?? 0,
					level: count === 0 ? 0 : Math.max(1, Math.ceil((count / maxCount) * 4))
				});
			}
			weeks.push(week);
		}
		return weeks;
	}

	const weeks = $derived(buildCells(visibleWeeks));

	const MONTHS = [
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];
	const DAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

	function levelClass(level: number): string {
		switch (level) {
			case 0:
				return 'bg-muted';
			case 1:
				return 'bg-emerald-200 dark:bg-emerald-900';
			case 2:
				return 'bg-emerald-400 dark:bg-emerald-700';
			case 3:
				return 'bg-emerald-500 dark:bg-emerald-500';
			default:
				return 'bg-emerald-600 dark:bg-emerald-400';
		}
	}

	const monthLabels = $derived(
		weeks.map((week, i) => {
			const firstDay = week.find((c) => c !== null);
			if (!firstDay) return '';
			if (i === 0) return MONTHS[firstDay.month];
			const prev = weeks[i - 1]?.find((c) => c !== null);
			if (prev && prev.month !== firstDay.month) return MONTHS[firstDay.month];
			return '';
		})
	);
</script>

<div class="flex flex-col gap-2" bind:clientWidth={containerWidth}>
	{#if containerWidth > 0}
		<div class="flex gap-1.5">
			<div
				class="flex w-[28px] shrink-0 flex-col justify-between py-0.5 text-[10px] text-muted-foreground"
			>
				{#each DAYS as day, i (i)}
					<span class="flex h-[14px] items-center">{day}</span>
				{/each}
			</div>

			<div class="flex min-w-0 flex-1 flex-col gap-0.5">
				<div class="flex gap-[3px]">
					{#each monthLabels as label, i (i)}
						<span class="w-[14px] shrink-0 text-[10px] text-muted-foreground">{label}</span>
					{/each}
				</div>

				<div class="flex gap-[3px]">
					{#each weeks as week, wi (wi)}
						<div class="flex shrink-0 flex-col gap-[3px]">
							{#each week as cell, di (di)}
								{#if cell}
									<div
										class="size-[14px] rounded-[3px] {levelClass(cell.level)}"
										title="{MONTHS[cell.month]} {cell.dateNum}: {cell.count} request{cell.count !==
										1
											? 's'
											: ''}{cell.failed > 0 ? ` (${cell.failed} failed)` : ''}"
									></div>
								{:else}
									<div class="size-[14px]"></div>
								{/if}
							{/each}
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
		<span>Less</span>
		<div class="size-[10px] rounded-[2px] bg-muted"></div>
		<div class="size-[10px] rounded-[2px] bg-emerald-200 dark:bg-emerald-900"></div>
		<div class="size-[10px] rounded-[2px] bg-emerald-400 dark:bg-emerald-700"></div>
		<div class="size-[10px] rounded-[2px] bg-emerald-500 dark:bg-emerald-500"></div>
		<div class="size-[10px] rounded-[2px] bg-emerald-600 dark:bg-emerald-400"></div>
		<span>More</span>
	</div>
</div>
