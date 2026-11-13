import type { Tool } from 'ai';

/** How one tool call went, for usage tracking. */
export interface McpToolCallOutcome {
	tool: string;
	/** False when the call threw or the server answered with an MCP error result. */
	ok: boolean;
	durationMs: number;
}

export interface WrapMcpToolsOptions {
	/** Sees every thrown error first (e.g. to drop a dead pooled connection). */
	onError?: (error: unknown) => void;
	/** Called once per finished call. */
	onCall?: (outcome: McpToolCallOutcome) => void;
}

/** MCP servers report a failed call as a result with `isError`, not by throwing. */
function isErrorResult(result: unknown): boolean {
	return (
		typeof result === 'object' &&
		result !== null &&
		(result as { isError?: unknown }).isError === true
	);
}

/** Prefixes errors thrown by MCP tools with their server and tool name. */
export function wrapMcpTools(
	set: Record<string, Tool>,
	serverName: string,
	{ onError, onCall }: WrapMcpToolsOptions = {}
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
				const started = performance.now();
				const settle = (ok: boolean) =>
					onCall?.({ tool: name, ok, durationMs: performance.now() - started });
				let result: unknown;
				try {
					result = await execute(input as never, options as never);
				} catch (e) {
					settle(false);
					onError?.(e);
					const message = e instanceof Error ? e.message : String(e);
					throw new Error(`[${serverName}/${name}] ${message}`, { cause: e });
				}
				settle(!isErrorResult(result));
				return result;
			}
		};
	}
	return wrapped;
}
