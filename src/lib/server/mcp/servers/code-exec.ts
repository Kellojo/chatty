import ivm from 'isolated-vm';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CallerContext } from '../types.js';
import { resolveInsideRealSync } from '../../safePath.js';
import { err, text } from './shared.js';

const MAX_OUTPUT = 64 * 1024; // 64KB
const MAX_TIMEOUT = 30000; // 30 seconds
const MAX_MEMORY = 512; // 512MB
const DEFAULT_TIMEOUT = 5000; // 5 seconds
const DEFAULT_MEMORY = 128; // 128MB
const MAX_CONCURRENT = 4;
/** Largest file readFile/writeFile move between host and sandbox. */
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

/** Formats the script's result inside the isolate, so any value comes out as a string. */
const FORMAT_RESULT = `(() => {
	const r = globalThis.__result;
	if (r === undefined) return undefined;
	if (typeof r === 'string') return r;
	try { return JSON.stringify(r) ?? String(r); } catch { return String(r); }
})()`;

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
		// Only a call that took a slot may give one back. Decrementing on the early
		// returns below drove the counter negative and disabled the cap.
		let acquired = false;

		try {
			const workspaceDir = validateWorkspaceDir(ctx.workspaceDir);

			if (activeExecutions >= MAX_CONCURRENT) {
				return err(`Too many concurrent executions (max ${MAX_CONCURRENT}). Try again later.`);
			}
			activeExecutions++;
			acquired = true;

			isolate = new ivm.Isolate({ memoryLimit: memoryMb });
			const context = await isolate.createContext();
			const jail = context.global;

			await jail.set('workspaceDir', workspaceDir);

			await jail.set(
				'readFile',
				new ivm.Callback((relPath: string) => {
					const abs = resolveInsideRealSync(workspaceDir, relPath);
					if (!abs) throw new Error('path escapes workspace root');
					const stat = fs.lstatSync(abs);
					if (stat.isSymbolicLink()) {
						throw new Error('accessing symlinks is not allowed');
					}
					// The isolate's memory limit doesn't cover the host-side copy.
					if (stat.size > MAX_FILE_BYTES) {
						throw new Error(`file too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`);
					}
					return fs.readFileSync(abs, 'utf-8');
				})
			);

			await jail.set(
				'writeFile',
				new ivm.Callback((relPath: string, content: string) => {
					const abs = resolveInsideRealSync(workspaceDir, relPath);
					if (!abs) throw new Error('path escapes workspace root');
					if (typeof content !== 'string') throw new Error('content must be a string');
					if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
						throw new Error(`content too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`);
					}
					try {
						fs.lstatSync(abs);
					} catch (e) {
						if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
					}
					fs.mkdirSync(path.dirname(abs), { recursive: true });
					fs.writeFileSync(abs, content, 'utf-8');
				})
			);

			// Logs live in host memory, outside the isolate's limit: stop collecting
			// once they exceed what the output can hold anyway (it's truncated below).
			const logs: string[] = [];
			let logChars = 0;
			const formatArg = (a: unknown): string => {
				if (typeof a === 'string') return a;
				try {
					return JSON.stringify(a) ?? String(a);
				} catch {
					return String(a);
				}
			};
			await jail.set(
				'log',
				new ivm.Callback((...args: unknown[]) => {
					if (logChars > MAX_OUTPUT) return;
					const line = args.map(formatArg).join(' ');
					logChars += line.length + 1;
					logs.push(line);
				})
			);

			const script = await isolate.compileScript(code);
			// Provide console.log/warn/error/etc. inside the sandbox so agents get
			// terminal-style output without having to know about the bare `log` global.
			const bootstrap = await isolate.compileScript(`
			globalThis.console = {
				log: (...args) => log(...args),
				info: (...args) => log(...args),
				warn: (...args) => log(...args),
				error: (...args) => log(...args),
				debug: (...args) => log(...args)
			};
		`);
			await bootstrap.run(context);
			// `promise` awaits a returned promise; the run timeout only covers the
			// synchronous part, so a never-settling promise is cut off here.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Script execution timed out.')), timeoutMs);
			});
			let result: unknown;
			try {
				const ref = await Promise.race([
					script.run(context, { timeout: timeoutMs, promise: true, reference: true }),
					deadline
				]);
				await jail.set('__result', ref.derefInto());
				result = await context.eval(FORMAT_RESULT, { timeout: timeoutMs });
			} finally {
				clearTimeout(timer);
			}

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
			if (acquired) activeExecutions--;
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
			description:
				'Execute JavaScript code in a sandbox with workspace file access. Use console.log()/console.error() for output; the last evaluated expression is returned as the result. Globals: readFile(path), writeFile(path, content).',
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
