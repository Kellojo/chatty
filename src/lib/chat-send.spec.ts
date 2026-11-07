import { describe, expect, it } from 'vitest';
import { parseSkillCommand } from './chat-send.js';

describe('parseSkillCommand', () => {
	it('leaves ordinary text alone', () => {
		expect(parseSkillCommand('hello there')).toEqual({ text: 'hello there' });
	});

	it('splits off a leading skill command', () => {
		expect(parseSkillCommand('/skill pdf-tools summarize this')).toEqual({
			text: 'summarize this',
			skill: 'pdf-tools'
		});
	});

	it('fills in a prompt when only the command is given', () => {
		expect(parseSkillCommand('/skill pdf-tools')).toEqual({
			text: 'Use the pdf-tools skill.',
			skill: 'pdf-tools'
		});
	});
});
