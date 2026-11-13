import type { Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { wrapMcpTools, type McpToolCallOutcome } from './wrap.js';

const tool = (execute: () => Promise<unknown>) => ({ execute }) as unknown as Tool;
type ExecuteOptions = Parameters<NonNullable<Tool['execute']>>[1];
const run = (t: Tool) =>
	t.execute!({}, { toolCallId: 'c1', messages: [] } as unknown as ExecuteOptions);

describe('wrapMcpTools', () => {
	it('reports a successful call', async () => {
		const calls: McpToolCallOutcome[] = [];
		const set = wrapMcpTools({ ok: tool(async () => ({ content: [] })) }, 'srv', {
			onCall: (o) => calls.push(o)
		});
		await expect(run(set.ok)).resolves.toEqual({ content: [] });
		expect(calls).toEqual([{ tool: 'ok', ok: true, durationMs: expect.any(Number) }]);
	});

	it('counts an MCP error result as failed', async () => {
		const onCall = vi.fn();
		const set = wrapMcpTools({ bad: tool(async () => ({ isError: true, content: [] })) }, 'srv', {
			onCall
		});
		await run(set.bad);
		expect(onCall).toHaveBeenCalledWith(expect.objectContaining({ tool: 'bad', ok: false }));
	});

	it('counts a thrown error as failed and prefixes its message', async () => {
		const onCall = vi.fn();
		const onError = vi.fn();
		const set = wrapMcpTools(
			{
				boom: tool(async () => {
					throw new Error('down');
				})
			},
			'srv',
			{ onCall, onError }
		);
		await expect(run(set.boom)).rejects.toThrow('[srv/boom] down');
		expect(onError).toHaveBeenCalledOnce();
		expect(onCall).toHaveBeenCalledWith(expect.objectContaining({ tool: 'boom', ok: false }));
	});
});
