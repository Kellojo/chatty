import { tool, type Tool, type UIMessage } from 'ai';
import { z } from 'zod';
import { ASK_USER_KINDS, ASK_USER_TOOL, isAskUserPart } from '$lib/ask-user.js';
import { extractText } from '../db/repo/messages.js';

export { ASK_USER_TOOL };

/**
 * Asks the user one question. It has no `execute`: the model's turn ends on the
 * call, and the user's next message is the answer (see `withAskUserAnswers`).
 */
export function askUserTool(): Tool {
	return tool({
		description:
			'Ask the user one question when you are blocked or need their decision, then stop: your turn ends and their reply continues the conversation. ' +
			'Do everything you can on your own first. Call it at most once per turn and put related questions into one. ' +
			'Offer concrete options when there are any, and always say which one you recommend.',
		inputSchema: z.object({
			question: z.string().min(1).describe('The question, short and self-contained'),
			kind: z
				.enum(ASK_USER_KINDS)
				.describe(
					'choice: pick one option; multi: pick several; confirm: approve or reject; text: free answer'
				),
			options: z
				.array(
					z.object({
						value: z.string().min(1),
						label: z.string().min(1),
						description: z.string().optional()
					})
				)
				.max(8)
				.optional()
				.describe('Options for choice/multi'),
			recommended: z.string().optional().describe('The option value (or answer) you recommend')
		})
	});
}

type Part = UIMessage['parts'][number];

/**
 * The prompt copy of `history` with every `ask_user` call answered: a call
 * followed by a user message gets that message's text as its output; any
 * further call in the same message is marked skipped (one question per turn).
 * The stored messages are never changed, so an edited answer (another branch)
 * pairs with whichever reply is on the shown path.
 */
export function withAskUserAnswers(history: UIMessage[]): UIMessage[] {
	return history.map((message, index) => {
		if (message.role !== 'assistant' || !message.parts.some(isAskUserPart)) return message;
		const next = history[index + 1];
		const answer = next?.role === 'user' ? extractText(next.parts).trim() : null;
		let answered = false;
		const parts = message.parts.map((part): Part => {
			if (!isAskUserPart(part) || part.state !== 'input-available') return part;
			if (answer === null) return part;
			const output = answered
				? { skipped: 'Only one question per turn' }
				: { answer: answer || '(no answer text)' };
			answered = true;
			return { ...part, state: 'output-available', output } as Part;
		});
		return { ...message, parts };
	});
}
