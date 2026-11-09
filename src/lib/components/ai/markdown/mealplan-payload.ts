/**
 * Payload parsing for the ```mealplan widget. Accepts Norish's planned-recipe
 * items verbatim (`{ id, date, slot, recipeName, recipeImage, servings,
 * calories, … }`), either as a bare array or under `items`/`meals`, plus a
 * few friendlier aliases (`name`, `image`, `minutes`, `url`).
 */

export const SLOTS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'] as const;
export type Slot = (typeof SLOTS)[number];

export type Meal = {
	key: string;
	date: string;
	slot: Slot;
	name: string;
	recipeId: string | null;
	image: string | null;
	url: string | null;
	servings: number | null;
	calories: number | null;
	minutes: number | null;
	note: string | null;
};

export type PlanDay = { date: string; meals: Meal[] };

export type MealPlan = {
	title: string | null;
	from: string;
	to: string;
	days: PlanDay[];
	/** Meals in the plan (before the day cap). */
	total: number;
	/** Empty days between `from` and `to` are listed, so a week reads as a week. */
	filled: boolean;
};

/** Spans up to this many days list their empty days too; longer ones show planned days only. */
const FILL_MAX_DAYS = 7;
const MAX_DAYS = 31;
const MAX_MEALS_PER_DAY = 8;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

const rec = (v: unknown): Record<string, unknown> | null =>
	typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null =>
	typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null;
const num = (v: unknown): number | null => {
	const n = typeof v === 'string' && v.trim() ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** `YYYY-MM-DD` of a date-ish string, validated as a real calendar day. */
export function isoDay(v: unknown): string | null {
	const m = typeof v === 'string' ? DATE_RE.exec(v.trim()) : null;
	if (!m) return null;
	const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
	return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : null;
}

export function addDays(day: string, n: number): string {
	const [y, m, d] = day.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
	return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function slotOf(v: unknown): Slot | null {
	const s = str(v)?.toLowerCase();
	if (!s) return null;
	return SLOTS.find((slot) => slot.toLowerCase() === s) ?? null;
}

/** Absolute http(s) or inline data:image URLs only; Norish's relative `/recipes/…` paths are dropped. */
function imageUrl(v: unknown): string | null {
	const s = str(v);
	if (!s) return null;
	if (/^data:image\//i.test(s)) return s;
	return URL.canParse(s) && /^https?:$/.test(new URL(s).protocol) ? new URL(s).href : null;
}

function webUrl(v: unknown): string | null {
	const s = str(v);
	return s && URL.canParse(s) && /^https?:$/.test(new URL(s).protocol) ? new URL(s).href : null;
}

function parseMeal(v: unknown, i: number): Meal | null {
	const m = rec(v);
	if (!m) return null;
	const date = isoDay(m.date);
	const slot = slotOf(m.slot ?? m.meal ?? m.category);
	const name = str(m.recipeName) ?? str(m.name) ?? str(m.title);
	if (!date || !slot || !name) return null;
	return {
		key: str(m.id) ?? `${date}-${slot}-${i}`,
		date,
		slot,
		name,
		recipeId: str(m.recipeId),
		image: imageUrl(m.recipeImage ?? m.image),
		url: webUrl(m.url ?? m.recipeUrl),
		servings: num(m.servings),
		calories: num(m.calories),
		minutes: num(m.totalMinutes ?? m.minutes),
		note: str(m.note) ?? str(m.notes)
	};
}

export function parseMealPlan(code: string): MealPlan | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(code);
	} catch {
		return null;
	}
	const root = rec(parsed);
	const list = Array.isArray(parsed) ? parsed : (root?.items ?? root?.meals ?? root?.plan);
	if (!Array.isArray(list)) return null;

	const meals = list.map(parseMeal).filter((m): m is Meal => m !== null);
	const range = rec(root?.range);
	let from = isoDay(root?.from ?? range?.from);
	let to = isoDay(root?.to ?? range?.to);
	if (meals.length === 0 && !(from && to)) return null;

	const dates = meals.map((m) => m.date).sort();
	from ??= dates[0];
	to ??= dates.at(-1)!;
	if (daysBetween(from, to) < 0) [from, to] = [to, from];

	const byDate = new Map<string, Meal[]>();
	for (const meal of meals) {
		if (meal.date < from || meal.date > to) continue;
		const day = byDate.get(meal.date) ?? [];
		day.push(meal);
		byDate.set(meal.date, day);
	}
	const order = (m: Meal) => SLOTS.indexOf(m.slot);
	const dayOf = (date: string): PlanDay => ({
		date,
		meals: (byDate.get(date) ?? []).sort((a, b) => order(a) - order(b)).slice(0, MAX_MEALS_PER_DAY)
	});

	const span = daysBetween(from, to) + 1;
	const filled = span <= FILL_MAX_DAYS;
	const days = filled
		? Array.from({ length: span }, (_, i) => dayOf(addDays(from, i)))
		: [...byDate.keys()].sort().map(dayOf);

	return {
		title: str(root?.title),
		from,
		to,
		days: days.slice(0, MAX_DAYS),
		total: [...byDate.values()].reduce((n, day) => n + day.length, 0),
		filled
	};
}
