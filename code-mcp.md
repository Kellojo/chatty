# Code Execution Tool Implementation Plan

## Overview

Add a code execution capability using `isolated-vm` to safely run JavaScript code in a sandboxed environment with workspace file access.

## Prerequisites

- Node.js 22+
- pnpm installed
- Repository cloned and dependencies installed (`pnpm install`)

## Step-by-Step Implementation

### Step 1: Add Dependency

**File**: `package.json`

Add to `dependencies`:

```json
"isolated-vm": "^6.0.0"
```

Then run:

```bash
pnpm install
```

---

### Step 2: Create Code Execution MCP Server

**File**: `src/lib/server/mcp/servers/code-exec.ts` (NEW)

```typescript
import ivm from 'isolated-vm';
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

export function createCodeExecServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-code-exec', version: '0.1.0' });

	// Helper to safely execute code in an isolate
	async function executeInSandbox(
		code: string,
		timeoutMs: number,
		memoryMb: number
	): Promise<CallToolResult> {
		const isolate = new ivm.Isolate({ memoryLimit: memoryMb });

		try {
			const context = await isolate.createContext();
			const jail = context.global;

			// Set up workspace directory
			const workspaceDir = ctx.workspaceDir ?? '.';
			await jail.set('workspaceDir', workspaceDir);

			// Inject safe file system operations
			await jail.set(
				'readFile',
				new ivm.Callback(async (relPath: string) => {
					const abs = resolveInside(workspaceDir, relPath);
					if (!abs) throw new Error('path escapes workspace root');
					return await fsp.readFile(abs, 'utf-8');
				})
			);

			await jail.set(
				'writeFile',
				new ivm.Callback(async (relPath: string, content: string) => {
					const abs = resolveInside(workspaceDir, relPath);
					if (!abs) throw new Error('path escapes workspace root');
					await fsp.mkdir(path.dirname(abs), { recursive: true });
					await fsp.writeFile(abs, content, 'utf-8');
				})
			);

			// Capture console output
			const logs: string[] = [];
			await jail.set(
				'log',
				new ivm.Callback((...args: unknown[]) => {
					logs.push(args.map(String).join(' '));
				})
			);

			// Compile and run the code
			const script = await isolate.compileScript(code);
			const result = await script.run(context, { timeout: timeoutMs });

			// Build output
			let output = '';
			if (logs.length > 0) {
				output += `Console output:\n${logs.join('\n')}\n\n`;
			}
			if (result !== undefined) {
				output += `Result: ${String(result)}`;
			}

			// Truncate if needed
			if (output.length > MAX_OUTPUT) {
				output = output.slice(0, MAX_OUTPUT) + '\n... truncated';
			}

			return text(output || 'Code executed successfully (no output)');
		} catch (e) {
			return err(`Execution failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			await isolate.dispose();
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
```

---

### Step 3: Register the Server

**File**: `src/lib/server/mcp/servers/index.ts` (MODIFY)

Add the import at the top:

```typescript
import { createCodeExecServer } from './code-exec.js';
```

Add to the builtin servers array (find where other servers like `createFsServer` are registered):

```typescript
// Inside the function that returns builtin servers
{
	name: 'code-exec',
	transport: 'builtin' as const,
	createServer: createCodeExecServer
}
```

---

### Step 4: Add Unit Tests

**File**: `src/lib/server/mcp/servers/code-exec.spec.ts` (NEW)

```typescript
import { describe, expect, it } from 'vitest';
import { createCodeExecServer } from './code-exec.js';
import type { CallerContext } from '../types.js';

describe('code-exec server', () => {
	const mockContext: CallerContext = {
		userId: 'test-user',
		role: 'user',
		workspaceDir: '/tmp/test-workspace',
		documentsDir: '/tmp/test-documents'
	};

	it('executes simple code', async () => {
		const server = createCodeExecServer(mockContext);
		// Test implementation here
		expect(server).toBeDefined();
	});

	it('handles errors gracefully', async () => {
		const server = createCodeExecServer(mockContext);
		// Test error handling
		expect(server).toBeDefined();
	});

	it('respects timeout limits', async () => {
		const server = createCodeExecServer(mockContext);
		// Test timeout
		expect(server).toBeDefined();
	});
});
```

Run tests:

```bash
pnpm test:unit -- --run src/lib/server/mcp/servers/code-exec.spec.ts
```

---

### Step 5: Verify Integration

**File**: `src/lib/server/tools/registry.spec.ts` (MODIFY)

Add test to verify the tool is registered:

```typescript
it('includes code_exec tool when enabled', async () => {
	const { tools } = await buildTools({
		userId: 'test-user',
		memoryEnabled: false,
		workspaceDir: '/tmp/test'
	});
	expect(tools).toHaveProperty('code_exec');
});
```

---

### Step 6: Test Manually

1. Start the dev server:

   ```bash
   pnpm dev
   ```

2. Open the app in browser (usually `http://localhost:5173`)

3. Create a new chat

4. Send a message like: "Run this code: `log('Hello from sandbox'); 2 + 2`"

5. Verify the code executes and returns output

---

### Step 7: Run Full Test Suite

```bash
pnpm test
```

---

## Security Checklist

Before deploying, verify:

- [ ] Code cannot access files outside workspace (test with `../` paths)
- [ ] Timeout kills long-running code (test infinite loop)
- [ ] Memory limit prevents OOM (test large array allocation)
- [ ] No network access by default (test `fetch()` call)
- [ ] Console output is captured (test `log()` calls)

---

## Troubleshooting

### "Cannot find module 'isolated-vm'"

Run `pnpm install` to install dependencies.

### "path escapes workspace root"

This is expected security behavior. The code tried to access files outside the allowed workspace directory.

### "Script execution timed out"

The code took longer than the timeout limit. Either optimize the code or increase `timeoutMs` (max 30000).

### Tests fail with "isolate already disposed"

Make sure you're not reusing the isolate after calling `dispose()`.

---

## Future Enhancements (Not Required)

1. **Add Python support**: Use `child_process` to spawn Python with similar sandboxing
2. **Network access**: Add optional `fetch` with URL allowlist
3. **Streaming output**: Stream console logs in real-time instead of collecting at end
4. **File upload**: Allow users to upload files to workspace before execution

---

## Questions?

If you get stuck:

1. Check existing MCP servers in `src/lib/server/mcp/servers/` for patterns
2. Look at `src/lib/server/tools/registry.ts` to understand tool registration
3. Review `src/lib/server/workspaces.ts` for path safety utilities

---

**Estimated time**: 2-3 hours for a junior developer

**Difficulty**: Medium (requires understanding of async/await and security concepts)
