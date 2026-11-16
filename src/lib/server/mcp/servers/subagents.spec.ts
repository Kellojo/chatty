import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

// The subagent runner drives a whole chat turn; the tool's own job is passing the call on.
const runSubagent = vi.fn();
vi.doMock('../../agents/subagents.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../agents/subagents.js')>()),
	runSubagent
}));

const { createSubagentsServer } = await import('./subagents.js');
// run_subagent imports its runner (and with it the chat engine) on first use; load it
// here so that cold import doesn't count against a test's timeout on a busy machine.
await import('../../agents/subagents.js');
const { wrapMcpTools } = await import('../../tools/wrap.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

const ctx = { userId: 'u1', role: 'user', workspaceDir: null, documentsDir: '' };

async function callTool(
	name: string,
	args: Record<string, unknown>,
	callerCtx: Parameters<typeof createSubagentsServer>[0] = ctx
) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createSubagentsServer(callerCtx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return await tool.execute(args, { toolCallId: 't1', messages: [] });
	} finally {
		await client.close();
		await server.close();
	}
}

function resultText(res: unknown): string {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	return r.content?.[0]?.text ?? '';
}

function isErr(res: unknown): boolean {
	return (res as { isError?: boolean }).isError === true;
}

describe('run_subagent', () => {
	it("passes the model's tool call id through the in-memory transport to the runner", async () => {
		runSubagent.mockResolvedValueOnce({
			status: 'completed',
			result: 'All done',
			truncated: false,
			error: null,
			conversationId: 'sub-1',
			startedAt: 1,
			endedAt: 2
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = createSubagentsServer({ ...ctx, conversationId: 'chat-1' });
		await server.connect(serverTransport);
		const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
		try {
			// As a chat turn calls it: through the wrapper that marks the model's tool call.
			const tools = wrapMcpTools(await client.tools(), 'subagents');
			const tool = tools.run_subagent as unknown as {
				execute: (input: unknown, opts: unknown) => Promise<unknown>;
			};
			const res = await tool.execute(
				{ description: 'Find docs', prompt: 'Find the docs' },
				{ toolCallId: 'call-9', messages: [] }
			);
			expect(runSubagent).toHaveBeenCalledWith(
				expect.objectContaining({
					parentConversationId: 'chat-1',
					toolCallId: 'call-9',
					description: 'Find docs'
				})
			);
			const body = JSON.parse(resultText(res));
			expect(body).toMatchObject({ status: 'completed', result: 'All done' });
			expect(body.note).toMatch(/never give the user conversation ids/i);
		} finally {
			await client.close();
			await server.close();
		}
	});

	it('marks failed runs as tool errors and refuses without a conversation', async () => {
		runSubagent.mockResolvedValueOnce({
			status: 'failed',
			result: null,
			truncated: false,
			error: 'model unavailable',
			conversationId: 'sub-2'
		});
		const failed = await callTool(
			'run_subagent',
			{ description: 'x', prompt: 'y' },
			{ ...ctx, conversationId: 'chat-1' }
		);
		expect(isErr(failed)).toBe(true);
		const none = await callTool('run_subagent', { description: 'x', prompt: 'y' });
		expect(resultText(none)).toMatch(/from a conversation/);
	});
});
