import { describe, expect, it } from 'vitest';
import type { ConversationRow } from '../db/repo/conversations.js';
import { BASE_PROMPT, buildSystemPrompt, todayLine } from './systemPrompt.js';
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
	it('returns BASE_PROMPT and the widgets when conversation has no system prompt and no global instructions', async () => {
		const conv = makeConv();
		expect(await buildSystemPrompt(conv)).toBe(basePrompt);
	});

	it('replaces BASE_PROMPT with the conversation system prompt but keeps the widgets', async () => {
		const conv = makeConv({ system_prompt: 'You are a pirate.' });
		expect(await buildSystemPrompt(conv)).toBe(`You are a pirate.

${widgets}`);
	});

	it('appends global instructions after BASE_PROMPT', async () => {
		const conv = makeConv();
		const result = await buildSystemPrompt(conv, 'never use emojis');
		expect(result).toBe(`${basePrompt}\n\nnever use emojis`);
	});

	it('appends global instructions after conversation prompt', async () => {
		const conv = makeConv({ system_prompt: 'You are a pirate.' });
		const result = await buildSystemPrompt(conv, 'always answer in German');
		expect(result).toBe(`You are a pirate.\n\n${widgets}\n\nalways answer in German`);
	});

	it('does not append whitespace-only global instructions', async () => {
		const conv = makeConv();
		expect(await buildSystemPrompt(conv, '   ')).toBe(basePrompt);
		expect(await buildSystemPrompt(conv, '\t\n')).toBe(basePrompt);
		expect(await buildSystemPrompt(conv, '')).toBe(basePrompt);
	});

	it('trims global instructions before appending', async () => {
		const conv = makeConv();
		const result = await buildSystemPrompt(conv, '   hello world   ');
		expect(result).toBe(`${basePrompt}\n\nhello world`);
	});
});

describe('todayLine', () => {
	it('states the date in the given zone, where it may already be tomorrow', () => {
		const now = new Date('2026-11-21T23:30:00Z');
		expect(todayLine(now, 'Europe/Berlin')).toBe(
			'Today is Sunday, 22 November 2026 (Europe/Berlin).'
		);
		expect(todayLine(now, 'UTC')).toBe('Today is Saturday, 21 November 2026 (UTC).');
	});

	it('puts the date ahead of the global instructions when asked to', async () => {
		const result = await buildSystemPrompt(makeConv(), {
			globalInstructions: 'be brief',
			today: new Date('2026-11-21T12:00:00Z')
		});
		expect(result).toMatch(/\n\nToday is Saturday, 21 November 2026 \([^)]+\)\.\n\nbe brief$/);
	});
});
