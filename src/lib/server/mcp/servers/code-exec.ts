import ivm from 'isolated-vm';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CallerContext } from '../types.js';
import { err, resolveInside, text } from './shared.js';

const MAX_OUTPUT = 64 * 1024; // 64KB
const MAX_TIMEOUT = 30000; // 30 seconds
const MAX_MEMORY = 512; // 512MB
const DEFAULT_TIMEOUT = 5000; // 5 seconds
const DEFAULT_MEMORY = 128; // 128MB
const MAX_CONCURRENT = 4;

let activeExecutions = 0;

function validateWorkspaceDir(workspaceDir: string | null): string {
	if (workspaceDir == null || workspaceDir === '') {
		throw new Error('workspace directory is not configured');
	}
	const resolved = path.resolve(workspaceDir);
	if (!path.isAbsolute(resolved)) {
		throw new Error('workspace directory must be an absolute path');
	}
	return resolved;
}

export function createCodeExecServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-code-exec', version: '0.1.0' });

	async function executeInSandbox(
		code: string,
		timeoutMs: number,
		memoryMb: number
	): Promise<CallToolResult> {
		let isolate: ivm.Isolate | undefined;

		try {
			const workspaceDir = validateWorkspaceDir(ctx.workspaceDir);

			if (activeExecutions >= MAX_CONCURRENT) {
				return err(`Too many concurrent executions (max ${MAX_CONCURRENT}). Try again later.`);
			}
			activeExecutions++;

			isolate = new ivm.Isolate({ memoryLimit: memoryMb });
			const context = await isolate.createContext();
			const jail = context.global;

			await jail.set('workspaceDir', workspaceDir);

			await jail.set(
				'readFile',
				new ivm.Callback((relPath: string) => {
					const abs = resolveInside(workspaceDir, relPath);
					if (!abs) throw new Error('path escapes workspace root');
					const stat = fs.lstatSync(abs);
					if (stat.isSymbolicLink()) {
						throw new Error('accessing symlinks is not allowed');
					}
					return fs.readFileSync(abs, 'utf-8');
				})
			);

			await jail.set(
				'writeFile',
				new ivm.Callback((relPath: string, content: string) => {
					const abs = resolveInside(workspaceDir, relPath);
					if (!abs) throw new Error('path escapes workspace root');
					try {
						fs.lstatSync(abs);
					} catch (e) {
						if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
					}
					fs.mkdirSync(path.dirname(abs), { recursive: true });
					fs.writeFileSync(abs, content, 'utf-8');
				})
			);

			const logs: string[] = [];
			await jail.set(
				'log',
				new ivm.Callback((...args: unknown[]) => {
					logs.push(args.map(String).join(' '));
				})
			);

			const script = await isolate.compileScript(code);
			const result = await script.run(context, { timeout: timeoutMs });

			let output = '';
			if (logs.length > 0) {
				output += `Console output:\n${logs.join('\n')}\n\n`;
			}
			if (result !== undefined) {
				output += `Result: ${String(result)}`;
			}

			if (output.length > MAX_OUTPUT) {
				output = output.slice(0, MAX_OUTPUT) + '\n... truncated';
			}

			return text(output || 'Code executed successfully (no output)');
		} catch (e) {
			return err(`Execution failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			activeExecutions--;
			if (isolate) {
				try {
					await isolate.dispose();
				} catch {
					// ignore disposal errors
				}
			}
		}
	}

	server.registerTool(
		'code_exec',
		{
			description: 'Execute JavaScript code in a sandbox with workspace file access',
			inputSchema: {
				code: z.string().describe('JavaScript code to execute'),
				timeoutMs: z
					.number()
					.int()
					.max(MAX_TIMEOUT)
					.optional()
					.describe(`Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}, max: ${MAX_TIMEOUT})`),
				memoryMb: z
					.number()
					.int()
					.max(MAX_MEMORY)
					.optional()
					.describe(`Memory limit in MB (default: ${DEFAULT_MEMORY}, max: ${MAX_MEMORY})`)
			}
		},
		async ({ code, timeoutMs = DEFAULT_TIMEOUT, memoryMb = DEFAULT_MEMORY }) => {
			return executeInSandbox(code, timeoutMs, memoryMb);
		}
	);

	return server;
}
