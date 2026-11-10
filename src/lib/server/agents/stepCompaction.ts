import { generateText, type ModelMessage } from 'ai';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { findModel } from '../db/repo/models.js';
import { createProxyRequest, finalizeProxyRequest } from '../db/repo/proxy-requests.js';
import { estimateTokens, summaryTarget } from '../chat/compact.js';
import { resolveModel } from '../llm/registry.js';
import { createLogger } from '../logger.js';
import { cacheTokens, computeUsageCostUsd } from '../proxy/pricing.js';

/**
 * In-run context compaction for agent tool loops.
 *
 * A run is one long `streamText` call, so chat compaction (which runs between
 * turns) never sees it, and every tool result piles up in the prompt. Before
 * each step this shrinks the messages once the prompt nears the model's
 * context window, cheapest first:
 *
 * 1. elide the outputs of older tool results (the model can re-run a tool),
 * 2. truncate any single recent tool result that alone eats the budget,
 * 3. fold older steps into an LLM-written progress summary.
 *
 * Each pass compacts well below the trigger point so the prompt cache is not
 * invalidated on every step. The returned messages carry forward to later
 * steps (the SDK reuses a `prepareStep` override), so nothing is redone.
 */

const log = createLogger('agent-compaction');

const SAFETY_MARGIN = 0.85;
const RESPONSE_RESERVE_TOKENS = 8192;
const MIN_THRESHOLD_TOKENS = 8000;
/** After compacting, aim for this share of the threshold (hysteresis). */
const TARGET_SHARE = 0.6;
/** Recent assistant steps (with their tool results) always kept verbatim. */
const KEEP_RECENT_STEPS = 2;
/** Tool outputs smaller than this are not worth eliding. */
const ELIDE_MIN_CHARS = 800;
const ELIDE_PREVIEW_CHARS = 240;
/** A single kept tool output may use at most this share of the threshold. */
const SINGLE_OUTPUT_SHARE = 0.25;
const TRANSCRIPT_PART_CHARS = 2000;
const SUMMARY_MAX_TOKENS = 2000;

export const SUMMARY_MARKER = '[Progress summary of earlier steps in this run]';
const SUMMARY_TRAILER =
	'Continue the task from where these steps left off; do not redo completed work.';

type ToolResultOutput = Extract<
	Exclude<ModelMessage['content'], string>[number],
	{ type: 'tool-result' }
>['output'];

/** Token threshold at which a run's prompt is compacted, or null when disabled. */
export function compactionThreshold(contextLength: number | null | undefined): number | null {
	if (config.CHAT_COMPACT_TOKENS === 0) return null;
	if (contextLength && contextLength > 0) {
		return Math.max(
			Math.floor((contextLength - RESPONSE_RESERVE_TOKENS) * SAFETY_MARGIN),
			MIN_THRESHOLD_TOKENS
		);
	}
	return config.CHAT_COMPACT_TOKENS;
}

export function estimateValueTokens(value: unknown): number {
	if (typeof value === 'string') return estimateTokens(value);
	try {
		return estimateTokens(JSON.stringify(value) ?? '');
	} catch {
		return 0;
	}
}

function outputText(output: ToolResultOutput): string {
	switch (output.type) {
		case 'text':
		case 'error-text':
			return output.value;
		case 'json':
		case 'error-json':
			return JSON.stringify(output.value) ?? '';
		case 'execution-denied':
			return `[denied${output.reason ? `: ${output.reason}` : ''}]`;
		case 'content':
			return output.value.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
		default:
			return JSON.stringify(output) ?? '';
	}
}

function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.7);
	const tail = max - head;
	return `${text.slice(0, head)}\n… [${text.length - max} chars truncated to save context] …\n${text.slice(-tail)}`;
}

function elidedOutput(output: ToolResultOutput): ToolResultOutput {
	const text = outputText(output);
	const preview = text.slice(0, ELIDE_PREVIEW_CHARS).trimEnd();
	return {
		type: 'text',
		value: `[Earlier tool output elided to save context (${text.length} chars). Preview: ${preview}${text.length > preview.length ? '…' : ''} — call the tool again if you need the full result.]`
	};
}

interface ToolResultRef {
	message: number;
	part: number;
	tokens: number;
	chars: number;
}

/** Splits messages into the leading prompt (up to the first assistant message) and steps. */
export function splitSteps(messages: ModelMessage[]): { prefixEnd: number; steps: number[][] } {
	const firstAssistant = messages.findIndex((m) => m.role === 'assistant');
	if (firstAssistant === -1) return { prefixEnd: messages.length, steps: [] };
	const steps: number[][] = [];
	for (let i = firstAssistant; i < messages.length; i++) {
		if (messages[i].role === 'assistant' || steps.length === 0) steps.push([i]);
		else steps[steps.length - 1].push(i);
	}
	return { prefixEnd: firstAssistant, steps };
}

function toolResults(messages: ModelMessage[], indices: number[]): ToolResultRef[] {
	const refs: ToolResultRef[] = [];
	for (const i of indices) {
		const content = messages[i].content;
		if (typeof content === 'string') continue;
		content.forEach((part, p) => {
			if (part.type !== 'tool-result') return;
			const text = outputText(part.output);
			refs.push({ message: i, part: p, chars: text.length, tokens: estimateTokens(text) });
		});
	}
	return refs;
}

/** Copy-on-write replacement of one tool result's output. */
function replaceOutput(
	messages: ModelMessage[],
	ref: ToolResultRef,
	output: ToolResultOutput
): ModelMessage[] {
	const next = messages.slice();
	const message = next[ref.message] as Extract<ModelMessage, { role: 'tool' | 'assistant' }>;
	const content = (message.content as Exclude<typeof message.content, string>).slice();
	const part = content[ref.part] as Extract<(typeof content)[number], { type: 'tool-result' }>;
	content[ref.part] = { ...part, output };
	next[ref.message] = { ...message, content } as ModelMessage;
	return next;
}

/** Text the summarizer sees for a step: assistant text and tool calls/results, truncated. */
export function stepTranscript(messages: ModelMessage[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (typeof m.content === 'string') {
			if (m.content.trim()) lines.push(`${m.role.toUpperCase()}: ${m.content}`);
			continue;
		}
		for (const part of m.content) {
			if (part.type === 'text' && part.text.trim()) {
				lines.push(`${m.role.toUpperCase()}: ${part.text}`);
			} else if (part.type === 'tool-call') {
				const input = typeof part.input === 'string' ? part.input : JSON.stringify(part.input);
				lines.push(
					`[tool call ${part.toolName}] ${truncateMiddle(input ?? '', TRANSCRIPT_PART_CHARS)}`
				);
			} else if (part.type === 'tool-result') {
				lines.push(
					`[tool result ${part.toolName}] ${truncateMiddle(outputText(part.output), TRANSCRIPT_PART_CHARS)}`
				);
			}
		}
	}
	return lines.join('\n');
}

function findSummary(messages: ModelMessage[], prefixEnd: number): string | null {
	for (let i = prefixEnd - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== 'user' || typeof m.content === 'string') continue;
		for (const part of m.content) {
			if (part.type === 'text' && part.text.startsWith(SUMMARY_MARKER)) {
				return part.text.slice(SUMMARY_MARKER.length).replace(SUMMARY_TRAILER, '').trim();
			}
		}
	}
	return null;
}

/** Puts the summary into the last user message of the prefix, replacing an older one. */
function withSummary(prefix: ModelMessage[], summary: string): ModelMessage[] {
	const text = `${SUMMARY_MARKER}\n${summary}\n\n${SUMMARY_TRAILER}`;
	const next = prefix.slice();
	for (let i = next.length - 1; i >= 0; i--) {
		const m = next[i];
		if (m.role !== 'user') continue;
		const parts =
			typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
		const kept = parts.filter((p) => !(p.type === 'text' && p.text.startsWith(SUMMARY_MARKER)));
		next[i] = { ...m, content: [...kept, { type: 'text', text }] };
		return next;
	}
	next.push({ role: 'user', content: [{ type: 'text', text }] });
	return next;
}

export type Summarize = (input: {
	transcript: string;
	previous: string | null;
}) => Promise<string | null>;

export interface CompactStepInput {
	messages: ModelMessage[];
	/** Best estimate of the full prompt (system + tools + messages) in tokens. */
	promptTokens: number;
	thresholdTokens: number;
	summarize?: Summarize;
	keepRecentSteps?: number;
}

export interface CompactStepResult {
	messages: ModelMessage[];
	stage: 'none' | 'elided' | 'summarized';
	beforeTokens: number;
	afterTokens: number;
	elided: number;
	truncated: number;
	foldedSteps: number;
}

export async function compactStepMessages(input: CompactStepInput): Promise<CompactStepResult> {
	const { thresholdTokens, promptTokens } = input;
	const result: CompactStepResult = {
		messages: input.messages,
		stage: 'none',
		beforeTokens: promptTokens,
		afterTokens: promptTokens,
		elided: 0,
		truncated: 0,
		foldedSteps: 0
	};
	if (promptTokens < thresholdTokens) return result;

	const target = Math.floor(thresholdTokens * TARGET_SHARE);
	const { prefixEnd, steps } = splitSteps(input.messages);
	const keep = Math.min(input.keepRecentSteps ?? KEEP_RECENT_STEPS, steps.length);
	const older = steps.slice(0, steps.length - keep);
	const recent = steps.slice(steps.length - keep);
	let messages = input.messages;
	let tokens = promptTokens;

	// 1. Elide older tool outputs, oldest first.
	for (const ref of toolResults(messages, older.flat())) {
		if (tokens <= target) break;
		if (ref.chars < ELIDE_MIN_CHARS) continue;
		const part = (messages[ref.message].content as Exclude<ModelMessage['content'], string>)[
			ref.part
		] as Extract<Exclude<ModelMessage['content'], string>[number], { type: 'tool-result' }>;
		const replacement = elidedOutput(part.output);
		messages = replaceOutput(messages, ref, replacement);
		tokens -= ref.tokens - estimateTokens(outputText(replacement));
		result.elided++;
	}

	// 2. Truncate recent outputs that alone blow the budget (e.g. a 1MB fetch).
	const maxChars = Math.floor(thresholdTokens * SINGLE_OUTPUT_SHARE) * 4;
	for (const ref of toolResults(messages, recent.flat())) {
		if (ref.chars <= maxChars) continue;
		const part = (messages[ref.message].content as Exclude<ModelMessage['content'], string>)[
			ref.part
		] as Extract<Exclude<ModelMessage['content'], string>[number], { type: 'tool-result' }>;
		const text = truncateMiddle(outputText(part.output), maxChars);
		messages = replaceOutput(messages, ref, { type: 'text', value: text });
		tokens -= ref.tokens - estimateTokens(text);
		result.truncated++;
	}

	if (result.elided + result.truncated > 0) result.stage = 'elided';

	// 3. Fold older steps into a running summary.
	if (tokens > target && input.summarize && older.length > 0) {
		const foldStart = older[0][0];
		const foldEnd = older[older.length - 1].at(-1)! + 1;
		const folded = input.messages.slice(foldStart, foldEnd);
		const previous = findSummary(messages, prefixEnd);
		let summary: string | null = null;
		try {
			summary = await input.summarize({ transcript: stepTranscript(folded), previous });
		} catch (e) {
			log.warn('Step summary failed; keeping elided history', {
				error: e instanceof Error ? e.message : String(e)
			});
		}
		if (summary?.trim()) {
			const removed = estimateValueTokens(messages.slice(foldStart, foldEnd));
			const prefix = withSummary(messages.slice(0, prefixEnd), summary.trim());
			const added = estimateValueTokens(prefix) - estimateValueTokens(messages.slice(0, prefixEnd));
			messages = [...prefix, ...messages.slice(foldEnd)];
			tokens = tokens - removed + added;
			result.stage = 'summarized';
			result.foldedSteps = older.length;
		}
	}

	result.messages = messages;
	result.afterTokens = Math.max(tokens, 0);
	return result;
}

const SUMMARY_PROMPT = `You are compressing the working history of an autonomous agent run so it fits the model's context window. The agent will continue from your summary, without the original steps.

Write a concise progress report preserving:
- what the task is and what has been completed so far
- key findings and data the agent will still need: ids, names, paths, URLs, numbers, code
- actions with side effects already performed (so they are not repeated)
- approaches that failed and why
- what remains to be done next

Output only the summary.`;

export interface RunSummarizerOptions {
	db: Db;
	userId: string;
	conversationId: string;
	runId: string;
	fallback: { providerId: string; modelId: string };
	abortSignal?: AbortSignal;
}

/** LLM summarizer for {@link compactStepMessages}, recorded as a 'compaction' request. */
export function createRunSummarizer(opts: RunSummarizerOptions): Summarize {
	return async ({ transcript, previous }) => {
		const { db } = opts;
		const target = summaryTarget(opts.fallback);
		const prompt = [
			SUMMARY_PROMPT,
			'',
			...(previous
				? [`Previous summary (extend it, do not repeat verbatim):\n${previous}`, '', 'New steps:']
				: ['Steps:']),
			transcript
		].join('\n');
		const row = createProxyRequest(db, {
			userId: opts.userId,
			source: 'agent',
			conversationId: opts.conversationId,
			runId: opts.runId,
			purpose: 'compaction',
			endpoint: 'generateText',
			requestedModel: target.modelId,
			stream: false
		});
		const startedAt = Date.now();
		try {
			const result = await generateText({
				model: resolveModel(target),
				prompt,
				maxOutputTokens: SUMMARY_MAX_TOKENS,
				abortSignal: opts.abortSignal
			});
			finalizeProxyRequest(db, row.id, {
				status: 'complete',
				latencyMs: Date.now() - startedAt,
				providerId: target.providerId,
				modelId: target.modelId,
				inputTokens: result.usage?.inputTokens ?? null,
				outputTokens: result.usage?.outputTokens ?? null,
				...cacheTokens(result.usage),
				costUsd: computeUsageCostUsd(findModel(db, target.providerId, target.modelId), result.usage)
			});
			return result.text.trim() || null;
		} catch (e) {
			finalizeProxyRequest(db, row.id, {
				status: 'failed',
				latencyMs: Date.now() - startedAt,
				providerId: target.providerId,
				modelId: target.modelId,
				error: e instanceof Error ? e.message : String(e)
			});
			throw e;
		}
	};
}
