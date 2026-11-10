import { describe, expect, it } from 'vitest';
import { errorSummary, readableErrorText } from './error-text.js';

describe('readableErrorText', () => {
	it('replaces a trailing JSON body with its message', () => {
		expect(
			readableErrorText(
				'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}'
			)
		).toBe('Engine protocol predict stream returned an error: Context size has been exceeded.');
	});

	it('reads nested OpenAI-style error objects', () => {
		expect(readableErrorText('{"error":{"message":"Rate limited","code":429}}')).toBe(
			'Rate limited'
		);
	});

	it('leaves plain text and unparseable bodies alone', () => {
		expect(readableErrorText('Network error')).toBe('Network error');
		expect(readableErrorText('Bad {json}')).toBe('Bad {json}');
		expect(readableErrorText('No message: {"code":500}')).toBe('No message: {"code":500}');
	});
});

describe('errorSummary', () => {
	it('keeps the most specific clause', () => {
		expect(
			errorSummary(
				'Engine protocol predict stream returned an error: Context size has been exceeded.'
			)
		).toBe('Context size has been exceeded.');
	});

	it('keeps the whole text when the last clause is too short to stand alone', () => {
		expect(errorSummary('Request failed: 500')).toBe('Request failed: 500');
		expect(errorSummary('Tool failed: undefined')).toBe('Tool failed: undefined');
		expect(errorSummary('Network error')).toBe('Network error');
	});
});
