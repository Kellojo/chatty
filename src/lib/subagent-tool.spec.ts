import { describe, expect, it } from 'vitest';
import { displayReport, parseSubagentToolResult, REPORT_CUT_MARKER } from './subagent-tool.js';

describe('subagent tool results', () => {
	it('shows a cut report without the marker meant for the model', () => {
		expect(displayReport(`abc\n\n${REPORT_CUT_MARKER}`)).toBe('abc');
		expect(displayReport('whole report')).toBe('whole report');
	});

	it('parses the JSON result and rejects refusals', () => {
		const output = (text: string) => ({ content: [{ type: 'text', text }] });
		expect(
			parseSubagentToolResult(
				output(
					JSON.stringify({
						status: 'completed',
						result: 'ok',
						conversationId: 'c1',
						droppedTools: ['x', 1]
					})
				)
			)
		).toMatchObject({
			status: 'completed',
			result: 'ok',
			conversationId: 'c1',
			droppedTools: ['x']
		});
		expect(parseSubagentToolResult(output('error: 4 subagents are already working'))).toBeNull();
		expect(
			parseSubagentToolResult(output(JSON.stringify({ status: 'odd', conversationId: 'c' })))
		).toBeNull();
	});
});
