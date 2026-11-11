import { describe, expect, it } from 'vitest';
import { INPUT_EVENTS, reportedPath } from './presence.js';

describe('presence reporting', () => {
	it('reports the path only while the tab is visible', () => {
		expect(reportedPath(true, '/chat/1')).toBe('/chat/1');
		expect(reportedPath(false, '/chat/1')).toBeNull();
	});

	it('counts only what a person does, not the chat scrolling itself while streaming', () => {
		expect(INPUT_EVENTS).not.toContain('scroll');
		expect(INPUT_EVENTS).toEqual(expect.arrayContaining(['pointerdown', 'keydown', 'wheel']));
	});
});
