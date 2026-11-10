import { describe, expect, it } from 'vitest';
import type { ConversationRow } from '../db/repo/conversations.js';
import { BASE_PROMPT, buildSystemPrompt } from './systemPrompt.js';
import { widgetsPrompt } from './widgets.js';

// Without tool names only the always-on widgets are listed.
const widgets = widgetsPrompt();
const basePrompt = `${BASE_PROMPT}

${widgets}`;

function makeConv(overrides: Partial<ConversationRow> = {}): ConversationRow {
	return {
		id: 'c1',
		user_id: 'u1',
		kind: 'chat',
		title: '',
		mode: 'chat',
		provider_id: null,
		model_id: null,
		system_prompt: null,
		memory_enabled: 0,
		max_steps: 0,
		temperature: null,
		max_tokens: null,
		pinned: 0,
		created_at: 0,
		updated_at: 0,
		deleted_at: null,
		...overrides
	} as unknown as ConversationRow;
}

describe('buildSystemPrompt', () => {
	it('returns BASE_PROMPT and the widgets when conversation has no system prompt and no global instructions', () => {
		const conv = makeConv();
		expect(buildSystemPrompt(conv)).toBe(basePrompt);
	});

	it('replaces BASE_PROMPT with the conversation system prompt but keeps the widgets', () => {
		const conv = makeConv({ system_prompt: 'You are a pirate.' });
		expect(buildSystemPrompt(conv)).toBe(`You are a pirate.

${widgets}`);
	});

	it('appends global instructions after BASE_PROMPT', () => {
		const conv = makeConv();
		const result = buildSystemPrompt(conv, 'never use emojis');
		expect(result).toBe(`${basePrompt}\n\nnever use emojis`);
	});

	it('appends global instructions after conversation prompt', () => {
		const conv = makeConv({ system_prompt: 'You are a pirate.' });
		const result = buildSystemPrompt(conv, 'always answer in German');
		expect(result).toBe(`You are a pirate.\n\n${widgets}\n\nalways answer in German`);
	});

	it('does not append whitespace-only global instructions', () => {
		const conv = makeConv();
		expect(buildSystemPrompt(conv, '   ')).toBe(basePrompt);
		expect(buildSystemPrompt(conv, '\t\n')).toBe(basePrompt);
		expect(buildSystemPrompt(conv, '')).toBe(basePrompt);
	});

	it('trims global instructions before appending', () => {
		const conv = makeConv();
		const result = buildSystemPrompt(conv, '   hello world   ');
		expect(result).toBe(`${basePrompt}\n\nhello world`);
	});
});
