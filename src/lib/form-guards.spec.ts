import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));

const { isSaveShortcut, missingHint } = await import('./form-guards.js');

describe('missingHint', () => {
	it('is null when nothing is missing', () => {
		expect(missingHint([false, null, undefined], 'save')).toBeNull();
	});

	it('joins one, two and three items readably', () => {
		expect(missingHint(['a title'], 'create')).toBe('Add a title to create.');
		expect(missingHint(['a name', false, 'a system prompt'], 'create')).toBe(
			'Add a name and a system prompt to create.'
		);
		expect(missingHint(['a', 'b', 'c'], 'save')).toBe('Add a, b and c to save.');
	});
});

describe('isSaveShortcut', () => {
	const key = (init: KeyboardEventInit) =>
		({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...init }) as KeyboardEvent;

	it('matches Ctrl+S and Cmd+S only', () => {
		expect(isSaveShortcut(key({ key: 's', ctrlKey: true }))).toBe(true);
		expect(isSaveShortcut(key({ key: 'S', metaKey: true }))).toBe(true);
		expect(isSaveShortcut(key({ key: 's' }))).toBe(false);
		expect(isSaveShortcut(key({ key: 's', ctrlKey: true, shiftKey: true }))).toBe(false);
	});
});
