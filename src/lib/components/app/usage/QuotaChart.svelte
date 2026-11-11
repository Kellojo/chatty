<script lang="ts">
	import { burndownTicks, formatBurndownTime, type BurndownPoint } from './burndown.js';
	import type { QuotaPool } from './quota.js';

	// What was left over the range (solid), then where today's burn rate leads through
	// future resets (dashed, each reset labelled with what it gives back).
	let {
		pool,
		color,
		ariaLabel,
		from,
		expiries = [],
		height = 220
	}: {
		pool: QuotaPool;
		/** Start of the selected range, so every card's axis starts on the same day. */
		from?: number;
		/** When extra resets lapse, marked on the time axis. */
		expiries?: number[];
		/** The provider's color; text never wears it. */
		color: string;
		ariaLabel: string;
		height?: number;
	} = $props();

	const uid = $props.id();
	const PAD = { top: 22, right: 8, bottom: 22, left: 44 };
	/** Reset labels closer than this (px) to the previous one are skipped. */
	const LABEL_GAP = 34;

	let width = $state(0);
	const plotW = $derived(Math.max(1, width - PAD.left - PAD.right));
	const plotH = $derived(height - PAD.top - PAD.bottom);
	const start = $derived(Math.min(from ?? Infinity, pool.recorded[0]?.at ?? Infinity, pool.asOf));
	const end = $derived(pool.projected.at(-1)?.at ?? pool.recorded.at(-1)?.at ?? start + 1);
	const span = $derived(Math.max(1, end - start));

	// A long range would squeeze the week ahead (what you plan with) into a sliver, so the
	// axis splits at the latest reading: the future always gets at least 30% of the width.
	const MIN_FUTURE = 0.3;
	const futureAt = $derived(pool.projected.length ? pool.asOf : null);
	const split = $derived.by(() => {
		if (futureAt === null || futureAt <= start || futureAt >= end) return null;
		const natural = (futureAt - start) / span;
		return natural > 1 - MIN_FUTURE ? 1 - MIN_FUTURE : null;
	});
	const x = (at: number) => {
		if (split === null || futureAt === null) return PAD.left + ((at - start) / span) * plotW;
		const f =
			at <= futureAt
				? ((at - start) / (futureAt - start)) * split
				: split + ((at - futureAt) / (end - futureAt)) * (1 - split);
		return PAD.left + f * plotW;
	};
	/** Time at a plot fraction `f` (0–1): the inverse of `x`. */
	const timeAt = (f: number) => {
		if (split === null || futureAt === null) return start + f * span;
		return f <= split
			? start + (f / split) * (futureAt - start)
			: futureAt + ((f - split) / (1 - split)) * (end - futureAt);
	};
	const y = (left: number) => PAD.top + (1 - left / pool.capacity) * plotH;
	const path = (points: BurndownPoint[]) =>
		points
			.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.remaining).toFixed(1)}`)
			.join('');

	// Before the first reading of a window that just began, the line is only assumed: it
	// is drawn faint and dotted, without the filled area that marks history.
	const assumedUntil = $derived(pool.assumedUntil);
	const assumedPoints = $derived(
		assumedUntil === null ? [] : pool.recorded.filter((p) => p.at <= assumedUntil)
	);
	const realPoints = $derived(
		assumedUntil === null ? pool.recorded : pool.recorded.filter((p) => p.at >= assumedUntil)
	);
	const assumed = $derived(assumedPoints.length > 1 ? path(assumedPoints) : '');
	const recorded = $derived(realPoints.length > 1 ? path(realPoints) : '');
	const area = $derived(
		recorded
			? `${recorded}L${x(realPoints.at(-1)!.at).toFixed(1)},${y(0)}L${x(realPoints[0].at).toFixed(1)},${y(0)}Z`
			: ''
	);
	const projected = $derived(pool.projected.length > 1 ? path(pool.projected) : '');
	const nowAt = $derived(pool.projected.length ? pool.asOf : null);
	const nowLeft = $derived(pool.recorded.at(-1)?.remaining ?? pool.remaining);

	const grid = $derived([0, pool.capacity / 2, pool.capacity]);

	// Stretches the projection sits at 0%: the time you'd be locked out, shaded so it reads
	// at a glance instead of as a hairline on the baseline.
	const emptySpans = $derived.by(() => {
		const out: { from: number; to: number }[] = [];
		const p = pool.projected;
		for (let i = 1; i < p.length; i++) {
			if (p[i - 1].remaining > 0.05 || p[i].remaining > 0.05 || p[i].at <= p[i - 1].at) continue;
			const last = out.at(-1);
			if (last && last.to === p[i - 1].at) last.to = p[i].at;
			else out.push({ from: p[i - 1].at, to: p[i].at });
		}
		return out;
	});
	const expiryMarks = $derived(expiries.filter((at) => at >= start && at <= end));
	const axis = $derived(burndownTicks(start, end, Math.max(2, Math.floor(plotW / 56))));
	// With a split axis, ticks bunch on the compressed side: keep those at least 48px apart.
	const ticks = $derived.by(() => {
		const out: number[] = [];
		for (const t of axis.ticks) {
			if (x(t) - PAD.left < 16 || PAD.left + plotW - x(t) < 16) continue;
			if (out.length && x(t) - x(out.at(-1)!) < 48) continue;
			out.push(t);
		}
		return out;
	});

	// Reset labels ("+71%") above each jump; crowded ones skipped.
	const resetLabels = $derived.by(() => {
		const out: { at: number; top: number; text: string }[] = [];
		for (const r of pool.resets) {
			if (r.gain < 0.5) continue;
			if (out.length && x(r.at) - x(out.at(-1)!.at) < LABEL_GAP) continue;
			// Keep clear of the "Now" label, which sits on the same top line.
			if (nowAt !== null && Math.abs(x(r.at) - x(nowAt)) < LABEL_GAP) continue;
			const top = pool.projected.findLast((p) => p.at === r.at)?.remaining ?? pool.capacity;
			out.push({ at: r.at, top, text: `+${Math.round(r.gain)}%` });
		}
		return out;
	});

	/** Linear value along `points` at `at` (the later value at a jump); null outside. */
	function along(points: BurndownPoint[], at: number): number | null {
		if (points.length === 0 || at < points[0].at || at > points.at(-1)!.at) return null;
		const i = points.findIndex((p) => p.at >= at);
		const c = points[i];
		const a = points[i - 1];
		if (!a || c.at === a.at) return c.remaining;
		return a.remaining + ((c.remaining - a.remaining) * (at - a.at)) / (c.at - a.at);
	}

	let hoverAt = $state<number | null>(null);
	const hover = $derived.by(() => {
		if (hoverAt === null) return null;
		const at = hoverAt;
		const rec = at <= pool.asOf ? along(pool.recorded, at) : null;
		const left = rec ?? along(pool.projected, at);
		const note =
			rec === null ? 'projected' : assumedUntil !== null && at < assumedUntil ? 'assumed' : null;
		return left === null ? null : { at, left, note };
	});

	function onPointer(e: PointerEvent) {
		const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
		const px = Math.min(Math.max(e.clientX - rect.left, PAD.left), PAD.left + plotW);
		hoverAt = timeAt((px - PAD.left) / plotW);
	}
</script>

<div class="relative w-full" bind:clientWidth={width} style:height="{height}px">
	{#if width > 0}
		<svg
			{width}
			{height}
			role="img"
			aria-label={ariaLabel}
			class="touch-pan-y overflow-visible"
			style:--series={color}
			onpointermove={onPointer}
			onpointerdown={onPointer}
			onpointerleave={() => (hoverAt = null)}
		>
			<defs>
				<linearGradient id="quota-fill-{uid}" x1="0" x2="0" y1="0" y2="1">
					<stop offset="0%" stop-color="var(--series-ink)" stop-opacity="0.22" />
					<stop offset="100%" stop-color="var(--series-ink)" stop-opacity="0.02" />
				</linearGradient>
			</defs>

			{#each grid as g (g)}
				<line
					x1={PAD.left}
					x2={PAD.left + plotW}
					y1={y(g)}
					y2={y(g)}
					class="stroke-border"
					stroke-width="1"
				/>
				<text
					x={PAD.left - 8}
					y={y(g)}
					dy="0.32em"
					text-anchor="end"
					class="fill-muted-foreground text-[11px] tabular-nums">{Math.round(g)}%</text
				>
			{/each}
			{#each ticks as t (t)}
				<text x={x(t)} y={height - 5} text-anchor="middle" class="fill-muted-foreground text-[11px]"
					>{axis.format(t)}</text
				>
			{/each}

			{#each emptySpans as e (e.from)}
				<rect
					x={x(e.from)}
					y={PAD.top}
					width={Math.max(1, x(e.to) - x(e.from))}
					height={plotH}
					class="fill-destructive/10 dark:fill-destructive/25"
				/>
				{#if x(e.to) - x(e.from) > 36}
					<text
						x={(x(e.from) + x(e.to)) / 2}
						y={y(0) - 6}
						text-anchor="middle"
						class="fill-destructive text-[11px] font-medium">Empty</text
					>
				{/if}
			{/each}
			{#each expiryMarks as at (at)}
				<!-- An extra reset lapses here: use it before this line. -->
				<line
					x1={x(at)}
					x2={x(at)}
					y1={PAD.top}
					y2={PAD.top + plotH}
					class="stroke-muted-foreground"
					stroke-width="1"
					stroke-dasharray="2 3"
				/>
				<path
					d="M{x(at)},{PAD.top + 12}l4.5,4.5l-4.5,4.5l-4.5,-4.5z"
					class="fill-card stroke-foreground"
					stroke-width="1.5"
				/>
			{/each}
			{#if area}
				<path d={area} fill="url(#quota-fill-{uid})" />
			{/if}
			{#if assumed}
				<path
					d={assumed}
					fill="none"
					style:stroke="var(--series-ink)"
					stroke-width="1.5"
					stroke-dasharray="1 4"
					stroke-linecap="round"
					stroke-opacity="0.6"
				/>
			{/if}
			{#if projected}
				<path
					d={projected}
					fill="none"
					style:stroke="var(--series-ink)"
					stroke-width="1.5"
					stroke-dasharray="5 4"
					stroke-opacity="0.8"
				/>
			{/if}
			{#if recorded}
				<path
					d={recorded}
					fill="none"
					style:stroke="var(--series-ink)"
					stroke-width="2"
					stroke-linejoin="round"
				/>
			{/if}

			{#each resetLabels as r (r.at)}
				<!-- Beside the jump, not across its dashed line. -->
				<text
					x={x(r.at) + 4}
					y={y(r.top) - 6}
					text-anchor="start"
					class="fill-muted-foreground text-[11px] tabular-nums">{r.text}</text
				>
			{/each}

			{#if nowAt !== null}
				<line
					x1={x(nowAt)}
					x2={x(nowAt)}
					y1={PAD.top - 6}
					y2={PAD.top + plotH}
					class="stroke-muted-foreground/50"
					stroke-width="1"
				/>
				<text
					x={x(nowAt)}
					y={PAD.top - 10}
					text-anchor="middle"
					class="fill-muted-foreground text-[11px]">Now</text
				>
				<circle
					cx={x(nowAt)}
					cy={y(nowLeft)}
					r="4"
					style:fill="var(--series-ink)"
					class="stroke-card"
					stroke-width="2"
				/>
			{/if}

			{#if hover}
				<line
					x1={x(hover.at)}
					x2={x(hover.at)}
					y1={PAD.top}
					y2={PAD.top + plotH}
					class="stroke-foreground/30"
					stroke-width="1"
				/>
				<circle
					cx={x(hover.at)}
					cy={y(hover.left)}
					r="4"
					style:fill="var(--series-ink)"
					class="stroke-card"
					stroke-width="2"
				/>
			{/if}
		</svg>

		{#if hover}
			{@const left = x(hover.at)}
			<div
				class="pointer-events-none absolute top-6 z-10 rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-sm"
				style:left="{left}px"
				style:transform="translateX({left > width / 2 ? 'calc(-100% - 8px)' : '8px'})"
			>
				<span class="text-muted-foreground">{formatBurndownTime(hover.at, span)} ·</span>
				<span class="font-medium tabular-nums">{Math.round(hover.left)}% left</span>
				{#if hover.note}<span class="text-muted-foreground"> · {hover.note}</span>{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	/* The provider color, lifted in dark mode so dark chart tokens still read on the card. */
	svg {
		--series-ink: var(--series);
	}
	:global(.dark) svg {
		--series-ink: color-mix(in oklch, var(--series), white 30%);
	}
</style>
