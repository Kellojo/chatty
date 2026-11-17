/**
 * Automatic privacy classification: asks the Decisions role model whether a
 * text holds sensitive personal data. Only used when that model only reaches
 * providers trusted with private data, since classifying means sending the
 * text to it. Its answer can only add the private flag, never remove it.
 */
import type { Db } from '../db/index.js';
import { findRoleModel } from '../db/repo/models.js';
import { forwardDecisions, type DecisionsRequest } from '../decisions/handler.js';
import { createLogger } from '../logger.js';
import { roleTrusted } from './models.js';

const log = createLogger('privacy');

/** Characters per classification call; longer texts are checked window by window. */
const WINDOW = 6000;
/** Windows overlap by this much, so a detail on a window boundary is seen whole. */
const OVERLAP = 200;
/** The most calls for one text; past that, windows are spread evenly over it. */
const MAX_WINDOWS = 8;

/**
 * The windows of `text` to classify: all of it when it fits in MAX_WINDOWS,
 * else MAX_WINDOWS windows spread from the start to the end.
 */
export function classificationWindows(text: string): string[] {
	if (text.length <= WINDOW) return [text];
	const step = WINDOW - OVERLAP;
	const starts: number[] = [];
	for (let at = 0; at < text.length - OVERLAP; at += step) starts.push(at);
	const picked =
		starts.length <= MAX_WINDOWS
			? starts
			: Array.from({ length: MAX_WINDOWS }, (_, i) =>
					Math.round((i * (text.length - WINDOW)) / (MAX_WINDOWS - 1))
				);
	return picked.map((at) => text.slice(at, at + WINDOW));
}

/**
 * One yes/no question per kind of sensitive data, with the label a person sees.
 * Any personally identifiable information counts: PII is split into narrow
 * questions (contact details, birth dates, full names, specific people) because
 * a small decision model answers those far more reliably than one broad one.
 */
const QUESTIONS = [
	{
		name: 'health',
		label: 'health',
		instructions:
			'Does the text contain health information about a person, such as illnesses, symptoms, medication, diagnoses, mental health or pregnancy?'
	},
	{
		name: 'money',
		label: 'money',
		instructions:
			'Does the text contain personal financial details, such as income, debts, account or card numbers, tax details or specific amounts a person owns or owes?'
	},
	{
		name: 'contact',
		label: 'contact details',
		instructions:
			'Does the text contain contact or identification details of a person, such as an email address, phone number, home address, or ID, passport, insurance or account numbers?'
	},
	{
		name: 'birthdate',
		label: 'a birth date',
		instructions: "Does the text give a person's date of birth or birthday?"
	},
	{
		name: 'name',
		label: 'a full name',
		instructions:
			'Does the text mention a private person by their full name (first and last name)? Well-known public figures, authors and historical people do not count.'
	},
	{
		name: 'people',
		label: 'specific people',
		instructions:
			'Does the text describe specific private people, such as family or household members, children, friends or colleagues, with names, ages, roles or relationships?'
	},
	{
		name: 'secrets',
		label: 'secrets',
		instructions: 'Does the text contain passwords, PINs, API keys, login details or other secrets?'
	},
	{
		name: 'intimate',
		label: 'personal matters',
		instructions:
			'Does the text contain intimate or sensitive personal matters, such as relationships, family conflicts, sexuality, religion, political views or legal trouble?'
	}
] as const;

/** Whether automatic classification can run: a Decisions model that only reaches trusted providers. */
export function canClassify(db: Db): boolean {
	return roleTrusted(db, 'decisions');
}

/**
 * From this probability up, a predicate counts as yes. Set low on purpose (any
 * PII should be private): with `laya`, PII notes scored 0.32-1.0 and harmless
 * ones at most 0.23 (a famous person's name).
 */
const YES_PROBABILITY = 0.3;

/**
 * A predicate answer's verdict: a probability, or a boolean (or "yes"/"no")
 * in whatever field the provider uses; null when it holds none of these, so
 * an answer the check can't read never passes for "nothing sensitive".
 */
export function verdictOf(answer: Record<string, unknown>): boolean | null {
	if (typeof answer.probability === 'number') return answer.probability >= YES_PROBABILITY;
	for (const key of ['value', 'answer', 'result', 'choice', 'predicate']) {
		const v = answer[key];
		if (typeof v === 'boolean') return v;
		if (typeof v === 'string' && /^(true|yes)$/i.test(v.trim())) return true;
		if (typeof v === 'string' && /^(false|no)$/i.test(v.trim())) return false;
	}
	return null;
}

/**
 * The kinds of sensitive data the text holds ("health", "money"…), [] when
 * none, or null when it couldn't be classified (no trusted Decisions model,
 * or the call failed). Callers treat null as "leave it as it is".
 */
export async function classifySensitive(db: Db, text: string): Promise<string[] | null> {
	const input = text.trim();
	if (!input) return null;
	const found = new Set<string>();
	// One window at a time: a long note's details can be anywhere in it. Any
	// failed window fails the whole check, so it is never recorded as done.
	for (const window of classificationWindows(input)) {
		// Read for every call: an admin may change or untrust the model meanwhile.
		const role = canClassify(db) ? findRoleModel(db, 'decisions') : undefined;
		if (!role) return null;
		const labels = await classifyWindow(role, window);
		if (labels === null) return null;
		for (const l of labels) found.add(l);
	}
	return QUESTIONS.filter((q) => found.has(q.label)).map((q) => q.label);
}

async function classifyWindow(
	role: { provider_id: string; model_id: string },
	input: string
): Promise<string[] | null> {
	const request: DecisionsRequest = {
		model: role.model_id,
		input,
		questions: QUESTIONS.map((q) => ({
			type: 'predicate' as const,
			name: q.name,
			instructions: q.instructions
		}))
	};
	try {
		// Private from the start: the text never goes to an untrusted target, fallbacks included.
		// The exact configured model: its name alone could resolve on another provider.
		const res = await forwardDecisions(
			request,
			{ tainted: true, reason: 'classification' },
			{ providerId: role.provider_id, modelId: role.model_id }
		);
		if (!res.ok) throw new Error(`Decisions call failed with ${res.status}`);
		const body = (await res.json()) as { answers?: unknown };
		if (!Array.isArray(body.answers)) throw new Error('Decisions reply has no answers');
		const answers = new Map(
			body.answers
				.filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
				.map((a) => [a.name, verdictOf(a)])
		);
		// Every question needs a readable answer: a partial or odd reply is a
		// failed check, never "nothing sensitive".
		const unread = QUESTIONS.filter((q) => typeof answers.get(q.name) !== 'boolean');
		if (unread.length > 0) {
			throw new Error(`Decisions reply has no verdict for ${unread.map((q) => q.name).join(', ')}`);
		}
		return QUESTIONS.filter((q) => answers.get(q.name) === true).map((q) => q.label);
	} catch (e) {
		log.warn('Privacy classification failed', {
			error: e instanceof Error ? e.message : String(e)
		});
		return null;
	}
}

/** The note a concept marked private automatically carries, e.g. "health, money". */
export function privateReasonFor(labels: string[]): string {
	return `Marked private automatically: looks like ${labels.join(', ')}`;
}

/** The suggestion an automatically marked note gets when it no longer looks personal. */
export const PRIVATE_REVIEW_NOTE =
	'No personal details found any more: it may not need to be private';

/** The privacy fields to write for a note, as `writeConcept` takes them. */
export interface PrivacyUpdate {
	private?: true;
	privateReason?: string;
	/** A string flags the note for review; null clears an earlier flag. */
	privateReview?: string | null;
}

/** The privacy fields of a note, as far as the check cares. */
type CurrentPrivacy = { private?: boolean; privateReason?: string; privateReview?: string };

/**
 * What a check that found `labels` means for a note whose privacy is
 * `current` (null for a new one), or null to leave it as it is:
 * - public note with personal details: private, with the reason;
 * - note marked private automatically: a fresh reason if it still has them,
 *   else a review flag. It stays private: only a person makes a note public;
 * - note a person (or a private chat) made private: never touched.
 */
export function reviewUpdate(
	current: CurrentPrivacy | null,
	labels: string[]
): PrivacyUpdate | null {
	const auto = current?.private === true && Boolean(current.privateReason);
	if (current?.private && !auto) return null;
	if (labels.length > 0) {
		const reason = privateReasonFor(labels);
		if (auto && current?.privateReason === reason && !current.privateReview) return null;
		return { private: true, privateReason: reason, privateReview: null };
	}
	if (auto) return current?.privateReview ? null : { privateReview: PRIVATE_REVIEW_NOTE };
	return null;
}
