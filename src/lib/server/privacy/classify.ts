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

/** Longer texts are cut; the start of a note says what it's about. */
const MAX_INPUT = 6000;

/** One yes/no question per kind of sensitive data, with the label a person sees. */
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
		name: 'identity',
		label: 'personal details',
		instructions:
			'Does the text contain identifying or contact details of a person, such as a home address, phone number, date of birth, or ID, passport or insurance numbers?'
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
 * From this probability up, a predicate counts as yes. LM Studio's decision
 * models answer with a probability: sensitive notes score well above it,
 * harmless ones near 0.
 */
const YES_PROBABILITY = 0.5;

/** A predicate answer's yes: a probability, or a boolean in whatever field the provider uses. */
function saidYes(answer: Record<string, unknown>): boolean {
	if (typeof answer.probability === 'number') return answer.probability >= YES_PROBABILITY;
	for (const key of ['value', 'answer', 'result', 'choice', 'predicate']) {
		const v = answer[key];
		if (v === true) return true;
		if (typeof v === 'string' && /^(true|yes)$/i.test(v.trim())) return true;
	}
	return false;
}

/**
 * The kinds of sensitive data the text holds ("health", "money"…), [] when
 * none, or null when it couldn't be classified (no trusted Decisions model,
 * or the call failed). Callers treat null as "leave it as it is".
 */
export async function classifySensitive(db: Db, text: string): Promise<string[] | null> {
	const input = text.trim().slice(0, MAX_INPUT);
	if (!input || !canClassify(db)) return null;
	const role = findRoleModel(db, 'decisions');
	if (!role) return null;
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
		const res = await forwardDecisions(request, { tainted: true, reason: 'classification' });
		const body = (await res.json()) as { answers?: unknown };
		if (!Array.isArray(body.answers)) return null;
		const yes = new Set(
			body.answers
				.filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
				.filter(saidYes)
				.map((a) => a.name)
		);
		return QUESTIONS.filter((q) => yes.has(q.name)).map((q) => q.label);
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
