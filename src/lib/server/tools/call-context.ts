import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The model's tool call a builtin MCP tool is running for. Builtin servers run
 * in-process (an in-memory transport), so the context set around a tool's
 * execute reaches their handlers; the MCP request itself carries no call id.
 * Undefined in external servers and outside a model's tool call.
 */
const storage = new AsyncLocalStorage<{ toolCallId: string }>();

export function runInToolCall<T>(toolCallId: string | undefined, fn: () => T): T {
	return toolCallId ? storage.run({ toolCallId }, fn) : fn();
}

export function currentToolCallId(): string | undefined {
	return storage.getStore()?.toolCallId;
}
