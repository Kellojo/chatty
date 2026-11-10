// The `ask_user` tool: an agent asks the user one question and ends its turn.
// Shared by the server (tool, prompt history) and the chat UI, which shows it in
// the same answer panel as a coding task's questions. The answer is never stored
// on the call: it is the user's next message.

import type { CodingPendingRequest } from './coding-environments.js';

export const ASK_USER_TOOL = 'ask_user';

/** Part type of an `ask_user` call in a UIMessage. */
export const ASK_USER_PART_TYPE = `tool-${ASK_USER_TOOL}`;

export const ASK_USER_KINDS = ['choice', 'multi', 'confirm', 'text'] as const;
export type AskUserKind = (typeof ASK_USER_KINDS)[number];

export interface AskUserOption {
	value: string;
	label: string;
	description?: string;
}

export interface AskUserInput {
	question: string;
	kind: AskUserKind;
	options?: AskUserOption[];
	/** The option value (or free text) the agent recommends. */
	recommended?: string;
}

/** A message part that is an `ask_user` call (any state). */
export interface AskUserPart {
	type: typeof ASK_USER_PART_TYPE;
	toolCallId: string;
	state: string;
	input?: unknown;
	output?: unknown;
}

export function isAskUserPart(part: { type: string }): part is AskUserPart {
	return part.type === ASK_USER_PART_TYPE;
}

/** The call's input, or null while it is still streaming or malformed. */
export function askUserInput(part: AskUserPart): AskUserInput | null {
	const input = part.input as Partial<AskUserInput> | undefined;
	if (!input || typeof input.question !== 'string' || !input.question.trim()) return null;
	const kind = ASK_USER_KINDS.includes(input.kind as AskUserKind)
		? (input.kind as AskUserKind)
		: 'text';
	const options = Array.isArray(input.options)
		? input.options.filter(
				(o): o is AskUserOption => !!o && typeof o.value === 'string' && typeof o.label === 'string'
			)
		: undefined;
	return {
		question: input.question,
		kind,
		options,
		recommended: typeof input.recommended === 'string' ? input.recommended : undefined
	};
}

/**
 * The open question a message ends with: its first `ask_user` call that has its
 * input but no answer yet. Later calls in the same message are not questions
 * (one per turn); see `withAskUserAnswers`.
 */
export function openAskUserCall(
	parts: readonly { type: string }[]
): { toolCallId: string; question: string } | null {
	for (const part of parts) {
		if (!isAskUserPart(part)) continue;
		if (part.state !== 'input-available') return null;
		const input = askUserInput(part);
		return input ? { toolCallId: part.toolCallId, question: input.question } : null;
	}
	return null;
}

/** The text the card sends for "decide yourself". */
export const DECIDE_YOURSELF_ANSWER = 'Use your recommendation.';

/**
 * The question as the answer panel's request (the one coding tasks use), plus
 * the text each option sends as the answer. Option ids are positional, so
 * repeated labels can't collide and an option's wording never decides how the
 * panel styles it (only Reject is destructive). The recommended option comes
 * first, where the panel highlights it.
 */
export function askUserRequest(
	toolCallId: string,
	input: AskUserInput
): { request: CodingPendingRequest; answers: Record<string, string> } {
	const recommended = input.recommended?.trim().toLowerCase() ?? '';
	type Choice = { id: string; label: string; description?: string; answer: string; best: boolean };
	const choices: Choice[] =
		input.kind === 'confirm'
			? [
					{
						id: 'approve',
						label: 'Approve',
						answer: 'Approved',
						best: /^(approve|yes|ok|confirm)/.test(recommended)
					},
					{
						id: 'reject',
						label: 'Reject',
						answer: 'Rejected',
						best: /^(reject|no|deny|decline)/.test(recommended)
					}
				]
			: (input.options ?? []).map((o, i) => ({
					id: `option-${i}`,
					label: o.label,
					...(o.description ? { description: o.description } : {}),
					answer: o.label,
					best:
						!!recommended &&
						(o.value.toLowerCase() === recommended || o.label.toLowerCase() === recommended)
				}));
	const ordered = [...choices.filter((c) => c.best), ...choices.filter((c) => !c.best)];
	if (ordered.length > 0) {
		ordered.push({
			id: 'decide',
			label: 'Decide yourself',
			answer: DECIDE_YOURSELF_ANSWER,
			best: false
		});
	}
	return {
		request: {
			requestId: toolCallId,
			kind: input.kind === 'confirm' ? 'approval' : 'question',
			title: input.question,
			detail: null,
			options: ordered.map(({ id, label, description }) => ({
				id,
				label,
				...(description ? { description } : {})
			})),
			allowFreeText: true,
			createdAt: 0,
			...(ordered.some((c) => c.best) ? { recommendedOptionId: ordered[0].id } : {}),
			...(ordered.length > 0 ? { deferOptionId: 'decide' } : {})
		},
		answers: Object.fromEntries(ordered.map((c) => [c.id, c.answer]))
	};
}
