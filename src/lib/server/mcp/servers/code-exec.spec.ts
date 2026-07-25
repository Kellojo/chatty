import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';

const { createCodeExecServer } = await import('./code-exec.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inmemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

let tmpDir: string;

beforeAll(async () => {
	tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'code-exec-test-'));
});

afterAll(async () => {
	await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function callCodeExec(args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const ctx = {
		userId: 'test-user',
		role: 'user',
		workspaceDir: tmpDir,
		documentsDir: path.join(tmpDir, 'documents')
	};
	const server = createCodeExecServer(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools.code_exec as unknown as {
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

describe('code-exec server', () => {
	it('executes simple arithmetic', async () => {
		const res = await callCodeExec({ code: '2 + 2' });
		expect(resultText(res)).toContain('Result: 4');
	});

	it('captures console.log output via log()', async () => {
		const res = await callCodeExec({ code: "log('hello world'); 'done'" });
		const text = resultText(res);
		expect(text).toContain('hello world');
		expect(text).toContain('Result: done');
	});

	it('handles syntax errors gracefully', async () => {
		const res = await callCodeExec({ code: 'this is not valid javascript @@' });
		expect((res as { isError?: boolean }).isError).toBe(true);
	});

	it('enforces timeout on infinite loops', async () => {
		const res = await callCodeExec({ code: 'while (true) {}', timeoutMs: 1000 });
		expect((res as { isError?: boolean }).isError).toBe(true);
	});

	it('can read files from workspace', async () => {
		await fsp.writeFile(path.join(tmpDir, 'test.txt'), 'hello file');
		const res = await callCodeExec({ code: "readFile('test.txt')" });
		expect(resultText(res)).toContain('hello file');
	});

	it('can write files to workspace', async () => {
		await callCodeExec({ code: "writeFile('output.txt', 'written content')" });
		const content = await fsp.readFile(path.join(tmpDir, 'output.txt'), 'utf-8');
		expect(content).toBe('written content');
	});

	it('prevents path traversal outside workspace', async () => {
		const res = await callCodeExec({ code: "readFile('../etc/passwd')" });
		expect((res as { isError?: boolean }).isError).toBe(true);
	});

	it('handles undefined return value gracefully', async () => {
		const res = await callCodeExec({ code: 'var x = 1;' });
		const text = resultText(res);
		expect(text).toContain('no output');
	});
});
