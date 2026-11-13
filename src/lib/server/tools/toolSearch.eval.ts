/**
 * Tool selection eval: does the model pick the right tool, with every tool
 * sent up front ("all") versus deferred tools loaded through search_tools
 * ("on-demand")? Calls the real model; tools are stubbed, so nothing runs.
 *
 *   EVAL_MODEL=qwen3:8b pnpm eval:tools
 *
 * EVAL_MODEL      model id (required); EVAL_PROVIDER picks the provider if the id is ambiguous
 * EVAL_RUNS       repetitions per case and mode (default 1)
 * EVAL_MODES      comma-separated subset of "all,on-demand" (default both)
 * EVAL_CASES      comma-separated case ids to run (default all)
 * EVAL_OUT        where to write the JSON results (default: the OS temp dir)
 *
 * Reads the app's database (DATABASE_PATH from .env) for providers, models and
 * MCP servers, and builds the tools as the first admin user.
 */
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateText, type StopCondition, type Tool, type ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
import { getDb } from '../db/index.js';
import { findEnabledModelByModelId, findModel } from '../db/repo/models.js';
import { getProvider } from '../db/repo/providers.js';
import { resolveModel } from '../llm/registry.js';
import { buildTools } from './registry.js';
import {
	deferredToolsPrompt,
	SEARCH_TOOLS_NAME,
	supportsNativeToolSearch,
	withToolSearch,
	type ToolCatalog
} from './toolSearch.js';

interface EvalCase {
	id: string;
	prompt: string;
	/** Any of these counts as the right tool. */
	expect: string[];
}

const CASES: EvalCase[] = [
	{ id: 'percent', prompt: "What's 17.5% of 2,340? Use a tool.", expect: ['calculate'] },
	{ id: 'power', prompt: 'What is 2^64 exactly?', expect: ['calculate'] },
	{
		id: 'stdev',
		prompt: 'What is the standard deviation of 4, 8, 15, 16, 23, 42?',
		expect: ['statistics']
	},
	{ id: 'units', prompt: 'How many feet are 3.2 kilometers?', expect: ['convert_units'] },
	{
		id: 'compound-units',
		prompt: 'Convert 2h 45min into minutes.',
		expect: ['convert_many', 'convert_units', 'calculate']
	},
	{ id: 'weather', prompt: "What's the weather in Lisbon right now?", expect: ['get_weather'] },
	{ id: 'forecast', prompt: 'Will it rain in Berlin tomorrow?', expect: ['get_weather'] },
	{
		id: 'time',
		prompt: 'What time is it in Tokyo right now?',
		expect: ['now', 'convert']
	},
	{
		id: 'fetch',
		prompt: 'Read https://example.com and summarize it in one sentence.',
		expect: ['fetch']
	},
	{ id: 'list-agents', prompt: 'Which agents do I have set up?', expect: ['list_agents'] },
	{
		id: 'create-agent',
		prompt: 'Create an agent called "standup" that summarizes my notes every weekday at 9am.',
		expect: ['create_agent']
	},
	{
		id: 'chat-search',
		prompt: 'What did we discuss in earlier chats about the Docker setup?',
		expect: ['search_chats']
	},
	{
		id: 'remember',
		prompt: 'Remember that my favourite editor is Helix.',
		expect: ['create_concept', 'update_concept', 'search_memory', 'list_concepts']
	},
	{
		id: 'recall',
		prompt: 'What do you remember about my job?',
		expect: ['search_memory', 'list_concepts', 'read_concept']
	},
	{ id: 'wait', prompt: 'Wait 5 seconds, then tell me a joke.', expect: ['wait'] },
	{
		id: 'settings',
		prompt: 'Which of my app settings can you change?',
		expect: ['list_settings', 'get_setting']
	},
	{
		id: 'image',
		prompt: 'Generate an image of a red fox in the snow.',
		expect: ['generate_image']
	},
	{
		id: 'code',
		prompt: 'Run this JavaScript and tell me its output: [1, 2, 3].map((x) => x * x)',
		expect: ['code_exec']
	},
	{ id: 'ls', prompt: 'List the files in my workspace.', expect: ['fs_ls', 'fs_glob'] },
	{
		id: 'wc',
		prompt: 'How many words does README.md in my workspace have?',
		expect: ['fs_read']
	}
];

type Mode = 'all' | 'on-demand';

interface CaseResult {
	case: string;
	mode: Mode;
	run: number;
	/** First tool called other than search_tools, if any. */
	tool: string | null;
	ok: boolean;
	searched: boolean;
	steps: number;
	inputTokens: number | null;
	outputTokens: number | null;
	ms: number;
	error?: string;
}

const SYSTEM =
	'You are a helpful assistant. Use the available tools whenever they help answer the request.';
const STUB = 'Stubbed result for an evaluation. Answer the user with what you have.';

/** Every tool answers with a stub, so the eval never acts on anything. */
function stubbed(catalog: ToolCatalog): ToolCatalog {
	const tools: Record<string, Tool> = {};
	for (const [name, t] of Object.entries(catalog.tools))
		tools[name] = { ...t, execute: async () => STUB };
	return { ...catalog, tools };
}

/** Stops once the model called a real tool: that call is what the eval scores. */
const calledRealTool: StopCondition<ToolSet> = ({ steps }) =>
	steps.at(-1)?.toolCalls.some((c) => c.toolName !== SEARCH_TOOLS_NAME) ?? false;

function resolveTarget(): { providerId: string; modelId: string } {
	const modelId = process.env.EVAL_MODEL;
	if (!modelId) throw new Error('Set EVAL_MODEL to the id of the model to evaluate');
	const db = getDb();
	const providerId = process.env.EVAL_PROVIDER;
	const row = providerId
		? findModel(db, providerId, modelId)
		: findEnabledModelByModelId(db, modelId);
	if (!row) throw new Error(`Model "${modelId}" not found${providerId ? ` on ${providerId}` : ''}`);
	return { providerId: row.provider_id, modelId: row.model_id };
}

function adminUserId(): string {
	const row = getDb()
		.prepare(`SELECT id FROM "user" ORDER BY role = 'admin' DESC, createdAt LIMIT 1`)
		.get() as { id: string } | undefined;
	if (!row) throw new Error('No user in the database');
	return row.id;
}

async function runCase(
	evalCase: EvalCase,
	mode: Mode,
	run: number,
	catalog: ToolCatalog,
	target: { providerId: string; modelId: string }
): Promise<CaseResult> {
	const providerType = getProvider(getDb(), target.providerId)?.type;
	const scoped = mode === 'all' ? { ...catalog, deferred: new Set<string>() } : catalog;
	const setup = withToolSearch(scoped, {
		native: supportsNativeToolSearch(providerType, target.modelId),
		loaded: new Set()
	});
	const section = deferredToolsPrompt(scoped);
	const startedAt = Date.now();
	try {
		const result = await generateText({
			model: resolveModel(target),
			system: section ? `${SYSTEM}\n\n${section}` : SYSTEM,
			prompt: evalCase.prompt,
			tools: setup.tools,
			stopWhen: [calledRealTool, ({ steps }) => steps.length >= 4],
			experimental_repairToolCall: setup.repairToolCall,
			prepareStep: () => {
				const activeTools = setup.activeTools();
				return activeTools ? { activeTools } : undefined;
			},
			abortSignal: AbortSignal.timeout(180_000)
		});
		const calls = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
		const tool = calls.find((name) => name !== SEARCH_TOOLS_NAME) ?? null;
		return {
			case: evalCase.id,
			mode,
			run,
			tool,
			ok: tool !== null && evalCase.expect.includes(tool),
			searched: calls.includes(SEARCH_TOOLS_NAME),
			steps: result.steps.length,
			inputTokens: result.totalUsage.inputTokens ?? null,
			outputTokens: result.totalUsage.outputTokens ?? null,
			ms: Date.now() - startedAt
		};
	} catch (e) {
		return {
			case: evalCase.id,
			mode,
			run,
			tool: null,
			ok: false,
			searched: false,
			steps: 0,
			inputTokens: null,
			outputTokens: null,
			ms: Date.now() - startedAt,
			error: e instanceof Error ? e.message : String(e)
		};
	}
}

function summarize(results: CaseResult[], mode: Mode) {
	const rows = results.filter((r) => r.mode === mode);
	const avg = (values: number[]) =>
		values.length === 0 ? null : Math.round(values.reduce((s, v) => s + v, 0) / values.length);
	return {
		mode,
		runs: rows.length,
		correct: `${rows.filter((r) => r.ok).length}/${rows.length}`,
		searched: rows.filter((r) => r.searched).length,
		errors: rows.filter((r) => r.error).length,
		avgSteps: avg(rows.map((r) => r.steps)),
		avgInputTokens: avg(rows.flatMap((r) => (r.inputTokens === null ? [] : [r.inputTokens]))),
		avgMs: avg(rows.map((r) => r.ms))
	};
}

describe('tool selection eval', () => {
	it('compares sending all tools with loading them on demand', async () => {
		const target = resolveTarget();
		const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
		const modes = (process.env.EVAL_MODES ?? 'all,on-demand')
			.split(',')
			.map((m) => m.trim())
			.filter((m): m is Mode => m === 'all' || m === 'on-demand');
		const only = process.env.EVAL_CASES?.split(',').map((c) => c.trim());

		const built = await buildTools({ userId: adminUserId(), memoryEnabled: true });
		const results: CaseResult[] = [];
		try {
			const catalog = stubbed(built);
			const cases = CASES.filter(
				(c) => (!only || only.includes(c.id)) && c.expect.some((name) => name in catalog.tools)
			);
			if (modes.includes('on-demand') && catalog.deferred.size === 0) {
				console.warn('No tools are deferred, so "on-demand" is the same as "all".');
			}
			for (const evalCase of cases) {
				for (const mode of modes) {
					for (let run = 1; run <= runs; run++) {
						const result = await runCase(evalCase, mode, run, catalog, target);
						results.push(result);
						console.log(
							`${result.ok ? 'ok  ' : 'MISS'} ${mode.padEnd(9)} ${evalCase.id.padEnd(15)} ` +
								`${(result.tool ?? '-').padEnd(16)} ${result.steps} steps ${result.ms} ms` +
								(result.error ? `  error: ${result.error}` : '')
						);
					}
				}
			}
		} finally {
			await built.close();
		}

		console.table(modes.map((mode) => summarize(results, mode)));
		const out =
			process.env.EVAL_OUT ??
			path.join(os.tmpdir(), `chatty-tool-eval-${target.modelId.replace(/[^\w.-]+/g, '_')}.json`);
		await writeFile(
			out,
			JSON.stringify({ target, deferred: [...built.deferred], results }, null, 2)
		);
		console.log(`Results written to ${out}`);
		expect(results.length).toBeGreaterThan(0);
	});
});
