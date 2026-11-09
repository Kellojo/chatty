<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import TicketIcon from '@lucide/svelte/icons/ticket';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import WidgetCard from './widget-card.svelte';
	import LinkSafetyModal from './link-safety-modal.svelte';
	import { cn } from '$lib/utils.js';
	import { daysBetween } from './mealplan-payload.js';
	import { parseEvents, type EventItem, type EventStatus } from './events-payload.js';

	/**
	 * A ```events fence: concerts, festivals, games, shows. Payload:
	 * `{ title?, timeZone?, events: [{ title, start, end?, allDay?, venue?, city?,
	 * lineup?, category?, image?, url?, price?, status?, doors?, notes? }] }`.
	 */
	type Props = {
		code: string;
		isIncomplete: boolean;
		/** Overrides for tests; default to the current time and the browser's zone. */
		now?: number;
		viewerTimeZone?: string;
	};

	let { code, isIncomplete, now, viewerTimeZone }: Props = $props();

	const list = $derived(isIncomplete ? null : parseEvents(code, viewerTimeZone));
	const today = $derived(
		new Intl.DateTimeFormat('en-CA', { timeZone: viewerTimeZone }).format(now ?? Date.now())
	);

	const utc = (day: string) => new Date(`${day}T12:00:00Z`);
	const fmt = (opts: Intl.DateTimeFormatOptions) =>
		new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' });
	const monthShort = fmt({ month: 'short' });
	const monthLong = fmt({ month: 'long', year: 'numeric' });
	const weekday = fmt({ weekday: 'short' });
	const fullDate = fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
	const rangeFmt = fmt({ month: 'short', day: 'numeric' });
	const timeFmt = new Intl.DateTimeFormat(undefined, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: 'UTC'
	});

	const time = (hhmm: string) => timeFmt.format(new Date(`2000-01-01T${hhmm}:00Z`));

	function timeLabel(e: EventItem): string | null {
		if (!e.start.time) return e.end && e.end.date !== e.start.date ? null : 'All day';
		if (e.end?.time && e.end.date === e.start.date)
			return `${time(e.start.time)} – ${time(e.end.time)}`;
		return time(e.start.time);
	}

	function relative(e: EventItem): { label: string; past: boolean } | null {
		const lastDay = e.end?.date ?? e.start.date;
		if (lastDay < today) return { label: 'Past', past: true };
		const d = daysBetween(today, e.start.date);
		if (d < 0) return { label: 'Happening now', past: false };
		if (d === 0) return { label: 'Today', past: false };
		if (d === 1) return { label: 'Tomorrow', past: false };
		if (d < 7) return { label: `In ${d} days`, past: false };
		return null;
	}

	const AMBER = 'bg-amber-500/12 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300';
	const STATUS: Record<EventStatus, { label: string; class: string }> = {
		soldout: { label: 'Sold out', class: 'bg-muted text-muted-foreground' },
		few: { label: 'Few tickets left', class: AMBER },
		cancelled: { label: 'Cancelled', class: 'bg-destructive/10 text-destructive' },
		postponed: { label: 'Postponed', class: AMBER },
		free: {
			label: 'Free',
			class: 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300'
		}
	};

	const subtitle = $derived.by(() => {
		if (!list) return null;
		const first = list.events[0].start.date;
		const last = list.events.reduce(
			(max, e) => ((e.end?.date ?? e.start.date) > max ? (e.end?.date ?? e.start.date) : max),
			first
		);
		return first === last
			? fullDate.format(utc(first))
			: rangeFmt.formatRange(utc(first), utc(last));
	});

	function ariaDate(e: EventItem): string {
		const t = timeLabel(e);
		const range =
			e.end && e.end.date !== e.start.date
				? `${fullDate.format(utc(e.start.date))} to ${fullDate.format(utc(e.end.date))}`
				: fullDate.format(utc(e.start.date));
		return t ? `${range}, ${t}` : range;
	}

	const linkLabel = (e: EventItem) =>
		e.status === 'cancelled' || e.status === 'soldout' || e.status === 'postponed'
			? 'Details'
			: 'Tickets';

	const failedImages = new SvelteSet<string>();

	let pendingUrl = $state<string | null>(null);
	function intercept(event: MouseEvent, url: string) {
		if (event.type === 'auxclick' && event.button !== 1) return;
		event.preventDefault();
		pendingUrl = url;
	}
</script>

{#snippet dateTile(event: EventItem, past: boolean)}
	<!-- A calendar page: tinted month over a large day, weekday underneath. -->
	<div
		class="flex w-12 shrink-0 flex-col items-center self-start rounded-xl bg-muted/60 py-1.5 text-center ring-1 ring-border/60 ring-inset"
		aria-label={ariaDate(event)}
		role="img"
	>
		<span
			class={cn(
				'text-[10px] leading-3 font-semibold tracking-wider uppercase',
				past ? 'text-muted-foreground' : 'text-rose-600 dark:text-rose-400'
			)}>{monthShort.format(utc(event.start.date))}</span
		>
		<span
			class={cn(
				'mt-0.5 text-xl leading-6 font-semibold tracking-tight tabular-nums',
				past && 'text-muted-foreground'
			)}>{Number(event.start.date.slice(8))}</span
		>
		<span class="text-[10px] leading-3 text-muted-foreground"
			>{weekday.format(utc(event.start.date))}</span
		>
	</div>
{/snippet}

<WidgetCard
	icon={TicketIcon}
	class="@container"
	status={list || isIncomplete ? 'ready' : 'error'}
	loadingLabel="Loading events…"
	errorLabel="Could not render events"
	raw={code}
	title={list?.title ?? 'Events'}
	{subtitle}
	meta={list
		? `${list.events.length < list.total ? `${list.events.length} of ${list.total}` : list.total} ${list.total === 1 ? 'event' : 'events'}`
		: 'Loading…'}
>
	{#if !list}
		<div class="flex flex-col gap-0.5 p-1.5" role="status" aria-busy="true">
			<span class="sr-only">Loading events…</span>
			{#each { length: 3 }, i (i)}
				<div class="flex gap-3 px-2.5 py-2.5" aria-hidden="true">
					<div
						class="h-[62px] w-12 animate-pulse rounded-xl bg-muted-foreground/15 motion-reduce:animate-none"
					></div>
					<div class="flex flex-1 flex-col gap-2 py-1">
						<div
							class="h-3 w-1/2 animate-pulse rounded-full bg-muted-foreground/15 motion-reduce:animate-none"
						></div>
						<div
							class="h-2.5 w-1/3 animate-pulse rounded-full bg-muted-foreground/10 motion-reduce:animate-none"
						></div>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="flex flex-col p-1.5">
			{#each list.months as month (month.key)}
				{#if list.months.length > 1}
					<h4
						class="px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
					>
						{monthLong.format(utc(`${month.key}-01`))}
					</h4>
				{/if}
				<ol class="flex flex-col gap-0.5">
					{#each month.events as event (event.key)}
						{@const rel = relative(event)}
						{@const t = timeLabel(event)}
						{@const cancelled = event.status === 'cancelled'}
						{@const place = [event.venue, event.city].filter(Boolean).join(', ')}
						{@const span =
							event.end && event.end.date !== event.start.date
								? rangeFmt.formatRange(utc(event.start.date), utc(event.end.date))
								: null}
						{@const price =
							event.price && event.status !== 'free' && !rel?.past ? event.price : null}
						<li class="flex min-w-0 gap-3 rounded-xl px-2.5 py-2.5">
							{@render dateTile(event, (rel?.past ?? false) || cancelled)}
							<div class="flex min-w-0 flex-1 flex-col gap-0.5">
								<h5
									class={cn(
										'text-sm leading-snug font-medium text-pretty break-words',
										(cancelled || rel?.past) && 'text-muted-foreground',
										cancelled && 'line-through'
									)}
								>
									{event.title}
								</h5>
								{#if event.lineup.length}
									<p class="line-clamp-1 text-xs text-muted-foreground">
										with {event.lineup.join(', ')}
									</p>
								{/if}
								<div
									class="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
								>
									{#if span}
										<span class="font-medium whitespace-nowrap text-foreground">{span}</span>
									{/if}
									{#if rel}
										<span
											class={cn(
												'whitespace-nowrap',
												rel.past ? 'text-muted-foreground' : 'font-medium text-foreground'
											)}>{rel.label}</span
										>
									{/if}
									{#if event.status}
										<span
											class={cn(
												'rounded-full px-1.5 py-px text-[11px] leading-4 font-medium whitespace-nowrap',
												STATUS[event.status].class
											)}>{STATUS[event.status].label}</span
										>
									{/if}
									{#if t}
										<span class="flex items-center gap-1 whitespace-nowrap tabular-nums">
											<ClockIcon class="size-3" aria-hidden="true" />
											{t}{#if event.doors}<span class="text-muted-foreground/80"
													>(doors {time(event.doors)})</span
												>{/if}
										</span>
									{/if}
									{#if place}
										<span class="flex max-w-full min-w-0 items-center gap-1">
											<MapPinIcon class="size-3 shrink-0" aria-hidden="true" />
											<span class="truncate">{place}</span>
										</span>
									{/if}
								</div>
								{#if event.url || price}
									<div class="mt-1.5 flex items-center gap-1.5 text-xs @md:hidden">
										{#if price}
											<span class="whitespace-nowrap text-foreground tabular-nums">{price}</span>
										{/if}
										{#if price && event.url}
											<span class="text-muted-foreground" aria-hidden="true">·</span>
										{/if}
										{#if event.url}
											<!-- eslint-disable svelte/no-navigation-without-resolve -- external ticket URL -->
											<a
												href={event.url}
												target="_blank"
												rel="noopener noreferrer"
												class="inline-flex w-fit items-center gap-0.5 rounded-sm text-xs font-medium text-rose-600 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none dark:text-rose-400"
												aria-label={`${linkLabel(event)} for ${event.title}`}
												onclick={(e) => intercept(e, event.url!)}
												onauxclick={(e) => intercept(e, event.url!)}
											>
												{linkLabel(event)}
												<ArrowUpRightIcon class="size-3.5" aria-hidden="true" />
											</a>
											<!-- eslint-enable svelte/no-navigation-without-resolve -->
										{/if}
									</div>
								{/if}
							</div>
							{#if event.image && !failedImages.has(event.image)}
								<img
									src={event.image}
									alt=""
									class="hidden aspect-square w-14 shrink-0 self-center rounded-lg object-cover ring-1 ring-border/60 @md:block dark:ring-white/10"
									loading="lazy"
									decoding="async"
									referrerpolicy="no-referrer"
									onerror={() => failedImages.add(event.image!)}
								/>
							{/if}
							{#if event.url || price}
								<div class="hidden shrink-0 flex-col items-end gap-1 pt-0.5 @md:flex">
									{#if price}
										<span class="text-xs whitespace-nowrap text-foreground tabular-nums"
											>{price}</span
										>
									{/if}
									{#if event.url}
										<!-- eslint-disable svelte/no-navigation-without-resolve -- external ticket URL -->
										<a
											href={event.url}
											target="_blank"
											rel="noopener noreferrer"
											class="flex h-8 items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
											aria-label={`${linkLabel(event)} for ${event.title}`}
											onclick={(e) => intercept(e, event.url!)}
											onauxclick={(e) => intercept(e, event.url!)}
										>
											{linkLabel(event)}
											<ArrowUpRightIcon class="size-3.5" aria-hidden="true" />
										</a>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ol>
			{/each}
		</div>
	{/if}
</WidgetCard>

<LinkSafetyModal
	url={pendingUrl ?? ''}
	isOpen={pendingUrl !== null}
	onClose={() => (pendingUrl = null)}
	onConfirm={() => {
		if (pendingUrl) window.open(pendingUrl, '_blank', 'noreferrer');
	}}
/>
