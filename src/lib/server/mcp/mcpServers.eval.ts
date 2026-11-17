/**
 * End-to-end MCP server eval: runs real chat turns (real tools, real model)
 * through the chat service and records which tools each turn used.
 *
 *   EVAL_USER=test.claude@gmail.com pnpm eval:tools src/lib/server/mcp/mcpServers.eval.ts
 *
 * EVAL_USER         email of the user the chats run as (required)
 * EVAL_MODEL        model or mapping name (default "auto")
 * EVAL_CONCURRENCY  scenarios at a time (default 2)
 * EVAL_CASES        comma-separated scenario ids (default all)
 * EVAL_OUT          JSON results path (default: OS temp dir)
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { getDb } from '../db/index.js';
import { createConversation, getConversation } from '../db/repo/conversations.js';
import { runChatTurnHeadless } from '../chat/service.js';

interface Scenario {
	id: string;
	/** Servers the scenario is meant to exercise. */
	servers: string[];
	/** One prompt per turn, all in the same conversation. */
	turns: string[];
}

const SCENARIOS: Scenario[] = [
	{
		id: 'birthday-math',
		servers: ['datetime', 'math'],
		turns: [
			'I was born on 1991-03-14. How many days old am I today, and which weekday was I born on? ' +
				'Also: if I invest €12,000 at 4.75% annual interest compounded monthly, what is it worth after 7 years?'
		]
	},
	{
		id: 'weather-ride',
		servers: ['weather', 'datetime', 'math'],
		turns: [
			"I want to go for a bike ride in Amsterdam tomorrow afternoon. What's the forecast (wind and rain matter most), " +
				'what time is it in Amsterdam right now, and what is the expected high in Fahrenheit?'
		]
	},
	{
		id: 'webfetch-sqlite',
		servers: ['webfetch', 'datetime', 'math'],
		turns: [
			'Read https://www.sqlite.org/chronology.html and tell me the latest SQLite release and its date, ' +
				'the first release listed, and how many years apart they are.'
		]
	},
	{
		id: 'code-fs-fibonacci',
		servers: ['code-exec', 'fs'],
		turns: [
			"Compute the first 25 Fibonacci numbers and each one's ratio to the previous number, save them as fib.csv " +
				'(columns n,value,ratio) in my workspace, then read the file back and tell me which constant the ratio converges to.'
		]
	},
	{
		id: 'memory-write',
		servers: ['memory'],
		turns: [
			'Please remember a few things about me for future chats: I am vegetarian, I am allergic to peanuts, ' +
				'and I work as a backend engineer in Rotterdam, mostly writing Go.'
		]
	},
	{
		id: 'skills-meeting-notes',
		servers: ['skills'],
		turns: [
			'Which skills do you have available? Then turn these raw notes into proper meeting notes: ' +
				'"sync w/ anna + tom 11/16. db migration slipping, tom thinks 2 more wks. anna to ask ops re downtime window. ' +
				'decided: freeze schema changes until migration done. me: update roadmap doc by fri. next sync thu."'
		]
	},
	{
		id: 'agents-create',
		servers: ['agents'],
		turns: [
			'Create an agent named "EVAL Morning Weather" that runs every weekday at 07:00 and tells me ' +
				"the day's weather for Rotterdam in two sentences. Don't run it now. Afterwards list my agents so I can see it's there."
		]
	},
	{
		id: 'stats-report',
		servers: ['math', 'fs'],
		turns: [
			'Here are my weekly running distances in miles: 12.4, 15.1, 9.8, 18.2, 14.6, 16.9, 11.3, 20.5. ' +
				'Give me the mean, median and standard deviation, the total in kilometres, and save a short markdown report ' +
				'as running-report.md in my workspace.'
		]
	},
	{
		id: 'wait-timezones',
		servers: ['datetime'],
		turns: [
			'Wait 5 seconds, then tell me the current time in Tokyo, New York and São Paulo, and how many hours Tokyo is ahead of New York.'
		]
	},
	{
		id: 'subagent-research',
		servers: ['subagents', 'webfetch'],
		turns: [
			'Use a subagent to read https://www.sqlite.org/wal.html and report the three biggest advantages and disadvantages of WAL mode, then give me a one-line verdict for a single-user web app.'
		]
	},
	{
		id: 'image-gen',
		servers: ['image'],
		turns: [
			'Generate an image of a lighthouse on a rocky coast at dusk, in a loose watercolor style.'
		]
	},
	{
		id: 'speech-tts',
		servers: ['speech'],
		turns: ['Read this out loud for me as audio: "The quick brown fox jumps over the lazy dog."']
	},
	{
		id: 'memory-chat-recall',
		servers: ['memory', 'chat-search'],
		turns: [
			'What do you know about my diet and my job? And did we talk about Fibonacci numbers in an earlier chat? If so, what was the result?',
			'Thanks. Based on what you know about me, suggest a simple dinner I could cook tonight.'
		]
	}
];

interface ToolCallRecord {
	tool: string;
	state: string;
	input: unknown;
	output?: string;
	error?: string;
}

interface TurnRecord {
	prompt: string;
	status: string;
	error: string | null;
	ms: number;
	tools: ToolCallRecord[];
	text: string;
	usage: unknown;
}

interface ScenarioResult {
	id: string;
	servers: string[];
	conversationId: string;
	turns: TurnRecord[];
}

const clip = (value: unknown, max = 1500): string => {
	const s = typeof value === 'string' ? value : JSON.stringify(value);
	return s === undefined ? '' : s.length > max ? `${s.slice(0, max)}… [${s.length} chars]` : s;
};

function resolveUser(email: string): string {
	const row = getDb().prepare('SELECT id FROM "user" WHERE email = ?').get(email) as
		{ id: string } | undefined;
	if (!row) throw new Error(`No user with email ${email}`);
	return row.id;
}

function resolveModel(name: string): { providerId: string; modelId: string } {
	const mapping = getDb()
		.prepare('SELECT id, name FROM model_mappings WHERE name = ?')
		.get(name) as { id: string; name: string } | undefined;
	if (mapping) return { providerId: `mapping:${mapping.id}`, modelId: mapping.name };
	const model = getDb()
		.prepare('SELECT provider_id, model_id FROM models WHERE model_id = ? LIMIT 1')
		.get(name) as { provider_id: string; model_id: string } | undefined;
	if (!model) throw new Error(`No model or mapping named ${name}`);
	return { providerId: model.provider_id, modelId: model.model_id };
}

function readTurn(conversationId: string, since: number) {
	const rows = getDb()
		.prepare(
			`SELECT parts, usage_json FROM messages
			 WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?
			 ORDER BY created_at`
		)
		.all(conversationId, since) as { parts: string; usage_json: string | null }[];
	const tools: ToolCallRecord[] = [];
	const text: string[] = [];
	let usage: unknown = null;
	for (const row of rows) {
		if (row.usage_json) usage = JSON.parse(row.usage_json);
		for (const part of JSON.parse(row.parts) as Record<string, unknown>[]) {
			const type = String(part.type);
			if (type === 'text') text.push(String(part.text));
			else if (type === 'dynamic-tool' || type.startsWith('tool-')) {
				tools.push({
					tool: type === 'dynamic-tool' ? String(part.toolName) : type.slice(5),
					state: String(part.state),
					input: part.input,
					output: part.output === undefined ? undefined : clip(part.output),
					error: part.errorText === undefined ? undefined : clip(part.errorText)
				});
			}
		}
	}
	return { tools, text: text.join('\n').trim(), usage };
}

async function runScenario(
	scenario: Scenario,
	userId: string,
	model: { providerId: string; modelId: string }
): Promise<ScenarioResult> {
	const db = getDb();
	const created = createConversation(db, userId, {
		title: `[eval] ${scenario.id}`,
		providerId: model.providerId,
		modelId: model.modelId,
		private: false
	});
	const result: ScenarioResult = {
		id: scenario.id,
		servers: scenario.servers,
		conversationId: created.id,
		turns: []
	};
	for (const prompt of scenario.turns) {
		const conversation = getConversation(db, userId, created.id)!;
		const startedAt = Date.now();
		const message: UIMessage = {
			id: randomUUID(),
			role: 'user',
			parts: [{ type: 'text', text: prompt }]
		};
		const outcome = await runChatTurnHeadless(userId, conversation, { message });
		const turn = readTurn(created.id, startedAt);
		result.turns.push({
			prompt,
			status: outcome.status,
			error: outcome.error,
			ms: Date.now() - startedAt,
			...turn
		});
		console.log(
			`[${scenario.id}] ${outcome.status} in ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
				`tools: ${turn.tools.map((t) => `${t.tool}${t.error ? '(!)' : ''}`).join(', ') || 'none'}`
		);
	}
	return result;
}

describe('MCP server end-to-end eval', () => {
	it('runs scenarios with real tools', async () => {
		const email = process.env.EVAL_USER;
		if (!email) throw new Error('Set EVAL_USER to the email of the user to run as');
		const userId = resolveUser(email);
		const model = resolveModel(process.env.EVAL_MODEL ?? 'auto');
		const concurrency = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 2));
		const only = process.env.EVAL_CASES?.split(',').map((c) => c.trim());
		const queue = SCENARIOS.filter((s) => !only || only.includes(s.id));
		// Scenarios that read what earlier ones wrote run last, on their own.
		const last = queue.filter((s) => s.id === 'memory-chat-recall');
		const first = queue.filter((s) => s.id !== 'memory-chat-recall');

		const results: ScenarioResult[] = [];
		const worker = async (items: Scenario[]) => {
			while (items.length > 0) {
				const next = items.shift()!;
				results.push(await runScenario(next, userId, model));
			}
		};
		await Promise.all(Array.from({ length: concurrency }, () => worker(first)));
		await worker(last);

		const out = process.env.EVAL_OUT ?? path.join(os.tmpdir(), 'chatty-mcp-eval.json');
		await writeFile(out, JSON.stringify({ model, results }, null, 2));
		console.log(`Results written to ${out}`);
		expect(results.length).toBe(queue.length);
	});
});
