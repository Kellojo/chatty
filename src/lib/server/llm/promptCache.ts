import type { ModelMessage, SystemModelMessage, Tool } from 'ai';

type ProviderOptions = NonNullable<ModelMessage['providerOptions']>;

const EPHEMERAL = { cacheControl: { type: 'ephemeral' } } as const;

function withBreakpoint(options: ProviderOptions | undefined): ProviderOptions {
	return { ...options, anthropic: { ...options?.anthropic, ...EPHEMERAL } };
}

/**
 * Adds Anthropic prompt-cache breakpoints (@ai-sdk/anthropic `cacheControl`) on
 * the last tool definition, the system prompt and the last history message.
 * Anthropic caches the prefix tools -> system -> messages up to each breakpoint,
 * so a follow-up turn re-reads everything up to the previous last message from
 * cache. That is 3 of the 4 breakpoints Anthropic allows. Inputs are not mutated.
 */
export function withAnthropicPromptCache(input: {
	system: string;
	messages: ModelMessage[];
	tools: Record<string, Tool>;
}): {
	system: string | SystemModelMessage;
	messages: ModelMessage[];
	tools: Record<string, Tool>;
} {
	// An empty text block is rejected by the API, so only a real prompt is marked.
	const system: string | SystemModelMessage = input.system
		? { role: 'system', content: input.system, providerOptions: withBreakpoint(undefined) }
		: input.system;

	const messages = [...input.messages];
	const last = messages.at(-1);
	if (last) {
		messages[messages.length - 1] = {
			...last,
			providerOptions: withBreakpoint(last.providerOptions)
		} as ModelMessage;
	}

	const tools = { ...input.tools };
	// Deferred tools (tool search) are not part of the cached prefix and cannot carry a breakpoint.
	const lastToolName = Object.keys(tools).findLast(
		(name) => tools[name].providerOptions?.anthropic?.deferLoading !== true
	);
	if (lastToolName) {
		const tool = tools[lastToolName];
		tools[lastToolName] = { ...tool, providerOptions: withBreakpoint(tool.providerOptions) };
	}

	return { system, messages, tools };
}
