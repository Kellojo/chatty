import type { Tool } from 'ai';

/**
 * Prefixes errors thrown by MCP tools with their server and tool name.
 * `onError` sees every thrown error first (e.g. to drop a dead pooled connection).
 */
export function wrapMcpTools(
	set: Record<string, Tool>,
	serverName: string,
	onError?: (error: unknown) => void
): Record<string, Tool> {
	const wrapped: Record<string, Tool> = {};
	for (const [name, tool] of Object.entries(set)) {
		const execute = tool.execute;
		if (!execute) {
			wrapped[name] = tool;
			continue;
		}
		wrapped[name] = {
			...tool,
			execute: async (input: unknown, options: Parameters<NonNullable<Tool['execute']>>[1]) => {
				try {
					return await execute(input as never, options as never);
				} catch (e) {
					onError?.(e);
					const message = e instanceof Error ? e.message : String(e);
					throw new Error(`[${serverName}/${name}] ${message}`, { cause: e });
				}
			}
		};
	}
	return wrapped;
}
