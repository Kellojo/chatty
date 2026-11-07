import { describe, expect, it } from 'vitest';
import { buildTranscript } from './handoff.js';

const msg = (role: string, content_text: string) => ({ role, content_text });

describe('buildTranscript', () => {
	it('labels user and assistant turns and skips the rest', () => {
		expect(
			buildTranscript([msg('user', 'fix it'), msg('system', 'hidden'), msg('assistant', ' sure ')])
		).toBe('User: fix it\n\nAssistant: sure');
	});

	it('keeps the newest messages within the budget', () => {
		const messages = [
			msg('user', 'a'.repeat(50)),
			msg('assistant', 'b'.repeat(50)),
			msg('user', 'c')
		];
		const transcript = buildTranscript(messages, 70);
		expect(transcript).not.toContain('a'.repeat(50));
		expect(transcript).toContain('b'.repeat(50));
		expect(transcript.endsWith('User: c')).toBe(true);
	});

	it('truncates very long messages', () => {
		expect(buildTranscript([msg('user', 'x'.repeat(5000))]).length).toBeLessThan(4100);
	});
});
