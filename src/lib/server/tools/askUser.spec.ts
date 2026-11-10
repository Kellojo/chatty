import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { askUserRequest, DECIDE_YOURSELF_ANSWER, openAskUserCall } from '$lib/ask-user.js';
import { withAskUserAnswers } from './askUser.js';

function ask(toolCallId: string, question = 'Archive them?') {
	return {
		type: 'tool-ask_user',
		toolCallId,
		state: 'input-available',
		input: { question, kind: 'confirm' }
	} as unknown as UIMessage['parts'][number];
}

const user = (id: string, text: string): UIMessage => ({
	id,
	role: 'user',
	parts: [{ type: 'text', text }]
});

describe('withAskUserAnswers', () => {
	it("answers a question with the user's next message", () => {
		const history: UIMessage[] = [
			user('u1', 'go'),
			{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Found 14.' }, ask('c1')] },
			user('u2', 'Approved')
		];
		const [, answered] = withAskUserAnswers(history);
		expect(answered.parts[1]).toMatchObject({
			state: 'output-available',
			output: { answer: 'Approved' }
		});
		// The stored history is left as it was.
		expect(history[1].parts[1]).toMatchObject({ state: 'input-available' });
	});

	it('answers only the first question of a message and skips the rest', () => {
		const history: UIMessage[] = [
			{ id: 'a1', role: 'assistant', parts: [ask('c1'), ask('c2', 'And this?')] },
			user('u2', 'Yes')
		];
		const [answered] = withAskUserAnswers(history);
		expect(answered.parts[0]).toMatchObject({ output: { answer: 'Yes' } });
		expect(answered.parts[1]).toMatchObject({
			state: 'output-available',
			output: { skipped: expect.any(String) }
		});
	});

	it('leaves a question without a reply open', () => {
		const history: UIMessage[] = [{ id: 'a1', role: 'assistant', parts: [ask('c1')] }];
		expect(withAskUserAnswers(history)[0].parts[0]).toMatchObject({ state: 'input-available' });
	});
});

describe('openAskUserCall', () => {
	it('returns the first unanswered question', () => {
		expect(openAskUserCall([{ type: 'text' }, ask('c1', 'Which one?')])).toEqual({
			toolCallId: 'c1',
			question: 'Which one?'
		});
	});

	it('returns null without a question or while its input still streams', () => {
		expect(openAskUserCall([{ type: 'text' }])).toBeNull();
		expect(
			openAskUserCall([{ ...ask('c1'), state: 'input-streaming' } as UIMessage['parts'][number]])
		).toBeNull();
	});
});

describe('askUserRequest', () => {
	it('puts the recommended option first and offers to let the agent decide', () => {
		const { request, answers } = askUserRequest('c1', {
			question: 'Which store?',
			kind: 'choice',
			options: [
				{ value: 'a', label: 'Aldi' },
				{ value: 'b', label: 'Billa', description: 'closer' }
			],
			recommended: 'b'
		});
		expect(request).toMatchObject({ requestId: 'c1', kind: 'question', title: 'Which store?' });
		expect(request.options.map((o) => answers[o.id])).toEqual([
			'Billa',
			'Aldi',
			DECIDE_YOURSELF_ANSWER
		]);
		expect(request.allowFreeText).toBe(true);
	});

	it('turns a confirm question into an approval', () => {
		const { request, answers } = askUserRequest('c1', {
			question: 'Delete?',
			kind: 'confirm',
			recommended: 'no'
		});
		expect(request.kind).toBe('approval');
		expect(request.options.map((o) => answers[o.id])).toEqual([
			'Rejected',
			'Approved',
			DECIDE_YOURSELF_ANSWER
		]);
	});

	it('keeps option ids unique and free of their wording', () => {
		const { request, answers } = askUserRequest('c1', {
			question: 'Which?',
			kind: 'choice',
			options: [
				{ value: 'a', label: 'Cancel the order' },
				{ value: 'b', label: 'Cancel the order' }
			]
		});
		const ids = request.options.map((o) => o.id);
		expect(new Set(ids).size).toBe(ids.length);
		// The panel styles ids like "cancel" as destructive; an option's label mustn't.
		expect(ids.some((id) => /cancel/i.test(id))).toBe(false);
		expect(answers[ids[0]]).toBe('Cancel the order');
	});

	it('is free text only without options', () => {
		expect(
			askUserRequest('c1', { question: 'How many people?', kind: 'text' }).request.options
		).toEqual([]);
	});
});
