import { createAnthropic } from '@ai-sdk/anthropic';
import {
	convertToModelMessages,
	generateText,
	stepCountIs,
	tool,
	type Tool,
	type UIMessage
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withAnthropicPromptCache } from '../llm/promptCache.js';
import {
	DEFER_MIN_CHARS,
	deferredToolsPrompt,
	loadedToolsFromHistory,
	pickDeferredTools,
	SEARCH_TOOLS_NAME,
	searchToolCatalog,
	supportsNativeToolSearch,
	withToolSearch,
	type ToolCatalog
} from './toolSearch.js';

function fakeTool(description: string): Tool {
	return tool({
		description,
		inputSchema: z.object({ q: z.string() }),
		execute: async () => 'ok'
	}) as Tool;
}

function catalog(): ToolCatalog {
	const tools: Record<string, Tool> = {
		fetch: fakeTool('Fetch a URL and return its content'),
		get_weather: fakeTool('Current weather and forecast for a location'),
		calculate: fakeTool('Evaluate an arithmetic expression'),
		convert_units: fakeTool('Convert a value between units of measure'),
		list_agents: fakeTool('List the agents of the user')
	};
	return {
		tools,
		toolToServer: {
			fetch: 'webfetch',
			get_weather: 'weather',
			calculate: 'math',
			convert_units: 'math',
			list_agents: 'agents'
		},
		deferred: new Set(['get_weather', 'calculate', 'convert_units', 'list_agents'])
	};
}

describe('pickDeferredTools', () => {
	it('defers the tools of deferred servers once they are large enough', () => {
		const big = fakeTool('x'.repeat(DEFER_MIN_CHARS));
		const tools = { a: big, b: fakeTool('b'), c: fakeTool('c') };
		const toolToServer = { a: 'one', b: 'one', c: 'two' };
		expect([...pickDeferredTools(tools, toolToServer, new Set(['one']))]).toEqual(['a', 'b']);
	});

	it('defers rarely used builtin tools but never the ones prompts name directly', () => {
		const big = fakeTool('x'.repeat(DEFER_MIN_CHARS));
		const tools = {
			load_skill: fakeTool('l'),
			read_skill_reference: fakeTool('r'),
			create_skill: big,
			fs_read: fakeTool('f'),
			fs_rm: fakeTool('rm'),
			now: fakeTool('n'),
			convert: fakeTool('c')
		};
		const toolToServer = {
			load_skill: 'skills',
			read_skill_reference: 'skills',
			create_skill: 'skills',
			fs_read: 'fs',
			fs_rm: 'fs',
			now: 'datetime',
			convert: 'datetime'
		};
		expect([...pickDeferredTools(tools, toolToServer, new Set())].sort()).toEqual([
			'convert',
			'create_skill',
			'fs_rm'
		]);
		// Even with the whole skills server on demand, the skills index keeps working.
		expect([...pickDeferredTools(tools, toolToServer, new Set(['skills']))].sort()).toEqual([
			'convert',
			'create_skill',
			'fs_rm'
		]);
	});

	it('defers nothing when the deferred tools are cheaper than a search round trip', () => {
		const tools = { a: fakeTool('a'), b: fakeTool('b') };
		expect(pickDeferredTools(tools, { a: 'one', b: 'one' }, new Set(['one'])).size).toBe(0);
	});
});

describe('searchToolCatalog', () => {
	it('ranks deferred tools by keyword and ignores loaded-by-default tools', () => {
		const found = searchToolCatalog(catalog(), 'weather forecast');
		expect(found[0]).toMatchObject({ name: 'get_weather', server: 'weather' });
		expect(searchToolCatalog(catalog(), 'fetch url').map((t) => t.name)).not.toContain('fetch');
	});

	it('matches server names, plurals and exact tool names', () => {
		expect(
			searchToolCatalog(catalog(), 'math')
				.map((t) => t.name)
				.sort()
		).toEqual(['calculate', 'convert_units']);
		expect(searchToolCatalog(catalog(), 'agents')[0].name).toBe('list_agents');
		expect(searchToolCatalog(catalog(), 'calculate, list_agents').map((t) => t.name)).toEqual(
			expect.arrayContaining(['calculate', 'list_agents'])
		);
	});

	it('returns nothing for unrelated queries and honours the limit', () => {
		expect(searchToolCatalog(catalog(), 'zebra')).toEqual([]);
		expect(searchToolCatalog(catalog(), 'math', 1)).toHaveLength(1);
	});
});

describe('deferredToolsPrompt', () => {
	it('lists deferred tools by server', () => {
		const prompt = deferredToolsPrompt(catalog());
		expect(prompt).toContain(SEARCH_TOOLS_NAME);
		expect(prompt).toContain('- math: calculate, convert_units');
		expect(prompt).toContain('- weather: get_weather');
		expect(prompt).not.toContain('fetch');
	});

	it('is empty when nothing is deferred', () => {
		expect(deferredToolsPrompt({ ...catalog(), deferred: new Set() })).toBe('');
	});
});

describe('loadedToolsFromHistory', () => {
	it('collects searched and called deferred tools from assistant messages', () => {
		const messages = [
			{
				id: 'a1',
				role: 'assistant',
				parts: [
					{
						type: `tool-${SEARCH_TOOLS_NAME}`,
						toolCallId: 's1',
						state: 'output-available',
						input: { query: 'weather' },
						output: { loaded: [{ name: 'get_weather', server: 'weather', description: '' }] }
					},
					{
						type: 'dynamic-tool',
						toolName: 'calculate',
						toolCallId: 'c1',
						state: 'output-available',
						input: {},
						output: 'ok'
					},
					{
						type: 'dynamic-tool',
						toolName: 'fetch',
						toolCallId: 'f1',
						state: 'output-available',
						input: {},
						output: 'ok'
					}
				]
			}
		] as UIMessage[];
		expect([...loadedToolsFromHistory(messages, catalog().deferred)].sort()).toEqual([
			'calculate',
			'get_weather'
		]);
	});
});

describe('supportsNativeToolSearch', () => {
	it('only enables Anthropic models that support tool search', () => {
		expect(supportsNativeToolSearch('anthropic', 'claude-sonnet-4-5-20250929')).toBe(true);
		expect(supportsNativeToolSearch('anthropic', 'claude-opus-4-8')).toBe(true);
		expect(supportsNativeToolSearch('anthropic', 'claude-opus-5-5')).toBe(true);
		expect(supportsNativeToolSearch('anthropic', 'claude-haiku-4-5')).toBe(false);
		expect(supportsNativeToolSearch('anthropic', 'claude-opus-4-1')).toBe(false);
		expect(supportsNativeToolSearch('anthropic', 'claude-3-7-sonnet-latest')).toBe(false);
		expect(supportsNativeToolSearch('openai-compatible', 'claude-sonnet-4-5')).toBe(false);
	});
});

describe('withToolSearch', () => {
	it('passes tools through unchanged when nothing is deferred', () => {
		const c = { ...catalog(), deferred: new Set<string>() };
		const setup = withToolSearch(c, { native: false, loaded: new Set() });
		expect(setup.tools).toBe(c.tools);
		expect(setup.activeTools()).toBeUndefined();
	});

	it('makes searched tools callable from the next step (non-native)', async () => {
		const setup = withToolSearch(catalog(), { native: false, loaded: new Set(['list_agents']) });
		const seen: string[][] = [];
		let call = 0;
		const usage = {
			inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 1, text: 1, reasoning: undefined }
		};
		const model = new MockLanguageModelV3({
			doGenerate: async (opts) => {
				seen.push((opts.tools ?? []).map((t) => t.name));
				call++;
				if (call === 1) {
					return {
						content: [
							{
								type: 'tool-call',
								toolCallId: 's1',
								toolName: SEARCH_TOOLS_NAME,
								input: JSON.stringify({ query: 'weather' })
							}
						],
						finishReason: { unified: 'tool-calls', raw: undefined },
						usage,
						warnings: []
					};
				}
				return {
					content: [{ type: 'text', text: 'done' }],
					finishReason: { unified: 'stop', raw: undefined },
					usage,
					warnings: []
				};
			}
		});
		await generateText({
			model,
			prompt: 'weather?',
			tools: setup.tools,
			stopWhen: stepCountIs(3),
			prepareStep: () => ({ activeTools: setup.activeTools() })
		});
		expect(seen[0].sort()).toEqual(['fetch', 'list_agents', SEARCH_TOOLS_NAME].sort());
		expect(seen[1]).toContain('get_weather');
		expect(seen[1]).not.toContain('calculate');
		expect(Object.keys(setup.promptTools())).toContain('get_weather');
	});

	it('sends deferred tools with defer_loading and search results as tool references (Anthropic)', async () => {
		const setup = withToolSearch(catalog(), { native: true, loaded: new Set() });
		expect(setup.activeTools()).toBeUndefined();
		expect(Object.keys(setup.promptTools()).sort()).toEqual(['fetch', SEARCH_TOOLS_NAME].sort());

		const history = [
			{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'weather in Lisbon?' }] },
			{
				id: 'a1',
				role: 'assistant',
				parts: [
					{
						type: `tool-${SEARCH_TOOLS_NAME}`,
						toolCallId: 'toolu_1',
						state: 'output-available',
						input: { query: 'weather' },
						output: { loaded: [{ name: 'get_weather', server: 'weather', description: '' }] }
					}
				]
			},
			{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'and tomorrow?' }] }
		] as UIMessage[];
		const messages = await convertToModelMessages(history, { tools: setup.historyTools });

		let body: {
			tools: { name: string; defer_loading?: boolean; cache_control?: unknown }[];
			messages: { content: { type: string; content?: unknown }[] }[];
		} | null = null;
		const provider = createAnthropic({
			apiKey: 'test',
			fetch: async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						id: 'msg_1',
						type: 'message',
						role: 'assistant',
						model: 'claude-sonnet-4-5',
						content: [{ type: 'text', text: 'ok' }],
						stop_reason: 'end_turn',
						stop_sequence: null,
						usage: { input_tokens: 1, output_tokens: 1 }
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
		});
		await generateText({
			model: provider('claude-sonnet-4-5'),
			maxOutputTokens: 10,
			...withAnthropicPromptCache({ system: 'sys', messages, tools: setup.tools })
		});
		const sent = body!;
		const byName = Object.fromEntries(sent.tools.map((t) => [t.name, t]));
		expect(byName.get_weather.defer_loading).toBe(true);
		expect(byName.fetch.defer_loading).toBeUndefined();
		// The cache breakpoint sits on the last tool that is part of the prefix.
		expect(byName[SEARCH_TOOLS_NAME].cache_control).toEqual({ type: 'ephemeral' });
		expect(byName.list_agents.cache_control).toBeUndefined();
		const result = sent.messages
			.flatMap((m) => m.content)
			.find((part) => part.type === 'tool_result');
		expect(result?.content).toEqual([{ type: 'tool_reference', tool_name: 'get_weather' }]);
	});
});

describe('withToolSearch repair', () => {
	it('turns a call to a tool that is not loaded yet into a search for it', async () => {
		const setup = withToolSearch(catalog(), { native: false, loaded: new Set() });
		const seen: string[][] = [];
		let call = 0;
		const usage = {
			inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 1, text: 1, reasoning: undefined }
		};
		const model = new MockLanguageModelV3({
			doGenerate: async (opts) => {
				seen.push((opts.tools ?? []).map((t) => t.name));
				call++;
				if (call === 1) {
					return {
						content: [
							{
								type: 'tool-call',
								toolCallId: 'c1',
								toolName: 'calculate',
								input: JSON.stringify({ q: '1+1' })
							}
						],
						finishReason: { unified: 'tool-calls', raw: undefined },
						usage,
						warnings: []
					};
				}
				return {
					content: [{ type: 'text', text: 'done' }],
					finishReason: { unified: 'stop', raw: undefined },
					usage,
					warnings: []
				};
			}
		});
		const result = await generateText({
			model,
			prompt: '1+1?',
			tools: setup.tools,
			stopWhen: stepCountIs(3),
			experimental_repairToolCall: setup.repairToolCall,
			prepareStep: () => ({ activeTools: setup.activeTools() })
		});
		const first = result.steps[0].toolResults[0];
		expect(first.toolName).toBe(SEARCH_TOOLS_NAME);
		expect(first.output).toMatchObject({
			loaded: [{ name: 'calculate' }],
			note: 'calculate is loaded now. Call it directly.'
		});
		expect(seen[0]).not.toContain('calculate');
		expect(seen[1]).toContain('calculate');
	});

	it('leaves unknown tools and native tool search alone', () => {
		expect(withToolSearch(catalog(), { native: true, loaded: new Set() }).repairToolCall).toBe(
			undefined
		);
		expect(
			withToolSearch({ ...catalog(), deferred: new Set() }, { native: false, loaded: new Set() })
				.repairToolCall
		).toBeUndefined();
	});
});
