<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import type { Component } from 'svelte';
	import UtensilsIcon from '@lucide/svelte/icons/utensils';
	import CoffeeIcon from '@lucide/svelte/icons/coffee';
	import SandwichIcon from '@lucide/svelte/icons/sandwich';
	import SoupIcon from '@lucide/svelte/icons/soup';
	import CookieIcon from '@lucide/svelte/icons/cookie';
	import UsersIcon from '@lucide/svelte/icons/users';
	import WidgetCard from './widget-card.svelte';
	import LinkSafetyModal from './link-safety-modal.svelte';
	import { cn } from '$lib/utils.js';
	import { daysBetween, parseMealPlan, type Meal, type Slot } from './mealplan-payload.js';

	/**
	 * A ```mealplan fence: planned meals per day and slot, e.g. Norish's
	 * `get_week_planned_recipes` items passed through verbatim. Payload:
	 * `{ title?, from?, to?, items: [{ date, slot, recipeName|name, recipeImage|image?,
	 * servings?, calories?, minutes?, url? }] }` or a bare array of items.
	 */
	type Props = {
		code: string;
		isIncomplete: boolean;
		/** Overrides for tests; default to the current time and the browser's zone. */
		now?: number;
		viewerTimeZone?: string;
	};

	let { code, isIncomplete, now, viewerTimeZone }: Props = $props();

	const plan = $derived(isIncomplete ? null : parseMealPlan(code));

	const today = $derived(
		new Intl.DateTimeFormat('en-CA', { timeZone: viewerTimeZone }).format(now ?? Date.now())
	);

	const SLOT_STYLE: Record<Slot, { icon: Component<{ class?: string }>; tint: string }> = {
		Breakfast: {
			icon: CoffeeIcon,
			tint: 'bg-amber-500/12 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300'
		},
		Lunch: {
			icon: SandwichIcon,
			tint: 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300'
		},
		Dinner: {
			icon: SoupIcon,
			tint: 'bg-indigo-500/12 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300'
		},
		Snack: {
			icon: CookieIcon,
			tint: 'bg-rose-500/12 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300'
		}
	};

	const utc = (day: string) => new Date(`${day}T12:00:00Z`);
	const fmt = (opts: Intl.DateTimeFormatOptions) =>
		new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' });
	const weekdayFmt = fmt({ weekday: 'short' });
	const longFmt = fmt({ weekday: 'long', month: 'long', day: 'numeric' });
	const rangeFmt = fmt({ month: 'short', day: 'numeric' });

	function rangeLabel(from: string, to: string): string {
		if (from === to) return longFmt.format(utc(from));
		return rangeFmt.formatRange(utc(from), utc(to));
	}

	function relative(day: string): string | null {
		const d = daysBetween(today, day);
		return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : null;
	}

	const numFmt = new Intl.NumberFormat();

	function duration(min: number): string {
		const h = Math.floor(min / 60);
		const m = min % 60;
		return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
	}

	/** Duration and calories after the slot; servings render separately with an icon. */
	function details(meal: Meal): string[] {
		const out: string[] = [];
		if (meal.minutes) out.push(duration(meal.minutes));
		if (meal.calories) out.push(`${numFmt.format(meal.calories)} kcal`);
		return out;
	}

	/** Total kcal, only when every meal has a calorie count (a partial sum would mislead). */
	const totalKcal = $derived.by(() => {
		const meals = plan?.days.flatMap((d) => d.meals) ?? [];
		if (meals.length === 0 || meals.some((m) => !m.calories)) return null;
		return meals.reduce((n, m) => n + m.calories!, 0);
	});

	const failedImages = new SvelteSet<string>();

	let pendingUrl = $state<string | null>(null);
	function intercept(event: MouseEvent, url: string) {
		if (event.type === 'auxclick' && event.button !== 1) return;
		event.preventDefault();
		pendingUrl = url;
	}
</script>

<WidgetCard
	icon={UtensilsIcon}
	class="@container"
	status={plan || isIncomplete ? 'ready' : 'error'}
	errorLabel="Could not render meal plan"
	raw={code}
	title={plan?.title ?? 'Meal plan'}
	subtitle={plan ? rangeLabel(plan.from, plan.to) : null}
	loadingLabel="Loading meal plan…"
	meta={plan
		? plan.total === 0
			? null
			: `${plan.total} ${plan.total === 1 ? 'meal' : 'meals'}${totalKcal ? ` · ${numFmt.format(totalKcal)} kcal` : ''}`
		: 'Loading…'}
>
	{#if !plan}
		<div class="flex flex-col divide-y divide-border/60" role="status" aria-busy="true">
			<span class="sr-only">Loading meal plan…</span>
			{#each { length: 3 }, i (i)}
				<div class="flex gap-4 px-4 py-3" aria-hidden="true">
					<div class="flex w-11 flex-col items-center gap-1.5">
						<div
							class="h-2 w-6 animate-pulse rounded-full bg-muted-foreground/15 motion-reduce:animate-none"
						></div>
						<div
							class="h-4 w-5 animate-pulse rounded bg-muted-foreground/15 motion-reduce:animate-none"
						></div>
					</div>
					<div class="flex flex-1 items-center gap-3">
						<div
							class="size-10 animate-pulse rounded-lg bg-muted-foreground/15 motion-reduce:animate-none"
						></div>
						<div class="flex flex-1 flex-col gap-2">
							<div
								class="h-3 w-1/2 animate-pulse rounded-full bg-muted-foreground/15 motion-reduce:animate-none"
							></div>
							<div
								class="h-2.5 w-1/3 animate-pulse rounded-full bg-muted-foreground/10 motion-reduce:animate-none"
							></div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{:else if plan.total === 0}
		<p class="px-4 py-6 text-center text-sm text-muted-foreground">Nothing planned yet.</p>
	{:else}
		<ol class="flex flex-col divide-y divide-border/60" aria-label={plan.title ?? 'Meal plan'}>
			{#each plan.days as day (day.date)}
				{@const rel = relative(day.date)}
				{@const isToday = day.date === today}
				{@const past = day.date < today}
				{@const single = plan.days.length === 1}
				{@const label = `${longFmt.format(utc(day.date))}${rel ? `, ${rel}` : ''}`}
				{#if day.meals.length === 0}
					<!-- Empty days collapse to one quiet line so a sparse week stays scannable. -->
					<li class="flex items-center gap-4 px-4 py-2">
						<span class="sr-only">{label}: nothing planned</span>
						<span
							class={cn(
								'flex w-11 shrink-0 items-baseline justify-center gap-1 text-xs whitespace-nowrap tabular-nums',
								isToday ? 'font-semibold text-foreground' : 'text-muted-foreground'
							)}
							aria-hidden="true"
						>
							<span class="text-[11px] font-medium tracking-wide uppercase"
								>{weekdayFmt.format(utc(day.date))}</span
							>{Number(day.date.slice(8))}
						</span>
						<span class="text-xs text-muted-foreground/80" aria-hidden="true">Nothing planned</span>
					</li>
				{:else}
					<li class="flex gap-4 px-4 py-3">
						<span class="sr-only">{label}</span>
						<div
							class={cn('flex w-11 shrink-0 flex-col items-center pt-0.5', single && 'hidden')}
							aria-hidden="true"
						>
							<span
								class={cn(
									'text-[11px] font-medium tracking-wide uppercase',
									isToday ? 'text-foreground' : 'text-muted-foreground'
								)}>{weekdayFmt.format(utc(day.date))}</span
							>
							<span
								class={cn(
									'mt-0.5 flex size-8 items-center justify-center rounded-full text-base font-semibold tabular-nums',
									isToday && 'bg-foreground text-background',
									past && 'text-muted-foreground'
								)}>{Number(day.date.slice(8))}</span
							>
						</div>
						{#if day.meals.length > 0}
							<ul class="flex min-w-0 flex-1 flex-col gap-2">
								{#each day.meals as meal (meal.key)}
									{@const style = SLOT_STYLE[meal.slot]}
									{@const info = details(meal)}
									<li class="flex min-w-0 items-center gap-3">
										{#if meal.image && !failedImages.has(meal.image)}
											<img
												src={meal.image}
												alt=""
												class="size-10 shrink-0 rounded-lg object-cover ring-1 ring-border/60 dark:ring-white/10"
												loading="lazy"
												decoding="async"
												referrerpolicy="no-referrer"
												onerror={() => failedImages.add(meal.image!)}
											/>
										{:else}
											<div
												class={cn(
													'flex size-10 shrink-0 items-center justify-center rounded-lg',
													style.tint
												)}
												aria-hidden="true"
											>
												<style.icon class="size-[18px]" />
											</div>
										{/if}
										<div class="flex min-w-0 flex-1 flex-col">
											{#if meal.url}
												<!-- eslint-disable svelte/no-navigation-without-resolve -- external recipe URL -->
												<a
													href={meal.url}
													target="_blank"
													rel="noopener noreferrer"
													class={cn(
														'line-clamp-3 rounded-sm text-sm leading-snug font-medium break-words underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none @md:line-clamp-2',
														past ? 'text-muted-foreground' : 'text-foreground'
													)}
													title={meal.name}
													onclick={(e) => intercept(e, meal.url!)}
													onauxclick={(e) => intercept(e, meal.url!)}>{meal.name}</a
												>
												<!-- eslint-enable svelte/no-navigation-without-resolve -->
											{:else}
												<span
													class={cn(
														'line-clamp-3 text-sm leading-snug font-medium break-words @md:line-clamp-2',
														past && 'text-muted-foreground'
													)}
													title={meal.name}>{meal.name}</span
												>
											{/if}
											<span
												class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
											>
												<span>{meal.slot}</span>
												{#if meal.servings}
													<span class="flex items-center gap-1 whitespace-nowrap tabular-nums"
														><span aria-hidden="true">·</span><UsersIcon
															class="size-3"
															aria-hidden="true"
														/>{meal.servings}<span class="sr-only"
															>{meal.servings === 1 ? 'serving' : 'servings'}</span
														></span
													>
												{/if}
												{#each info as part (part)}
													<span class="flex items-center gap-1 whitespace-nowrap tabular-nums"
														><span aria-hidden="true">·</span>{part}</span
													>
												{/each}
											</span>
										</div>
									</li>
								{/each}
							</ul>
						{/if}
					</li>
				{/if}
			{/each}
		</ol>
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
