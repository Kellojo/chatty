// Conversation export: one Markdown file with everything the DB holds about a
// chat (settings, the active message path with tool calls and reasoning, the
// model request log, compaction summaries and subagent transcripts), laid out
// for an AI (or a person) to analyse when debugging Chatty's behaviour.

import type { Db } from '../db/index.js';
import { getAgent } from '../db/repo/agents.js';
import type { ConversationRow } from '../db/repo/conversations.js';
import { branchesFor, listMessages, type MessageRow } from '../db/repo/messages.js';
import type { ConversationSummaryRow } from '../db/repo/conversation-summaries.js';
import type { ProxyRequestRow } from '../db/repo/proxy-requests.js';

/** Subagents of subagents are exported too, down to this depth. */
const MAX_SUBAGENT_DEPTH = 3;
/** Inline data (base64 files, data URLs) longer than this is elided. */
const MAX_INLINE_DATA_CHARS = 200;

export interface ExportedConversation {
	conversation: ConversationRow;
	agentName: string | null;
	messages: MessageRow[];
	/** Per message id: how many versions it has and which one is on the path. */
	branches: Map<string, { index: number; count: number }>;
	summaries: ConversationSummaryRow[];
	requests: ProxyRequestRow[];
	subagents: ExportedConversation[];
}

function loadTree(db: Db, conversation: ConversationRow, depth: number): ExportedConversation {
	const messages = listMessages(db, conversation.id);
	const branches = new Map<string, { index: number; count: number }>();
	for (const [id, b] of branchesFor(db, conversation.id, messages)) {
		branches.set(id, { index: b.index, count: b.count });
	}
	const agent = conversation.agent_id ? getAgent(db, conversation.agent_id) : undefined;
	const children =
		depth < MAX_SUBAGENT_DEPTH
			? (db
					.prepare(`SELECT * FROM conversations WHERE subagent_of = ? ORDER BY created_at`)
					.all(conversation.id) as ConversationRow[])
			: [];
	return {
		conversation,
		agentName: agent?.name ?? null,
		messages,
		branches,
		summaries: db
			.prepare(`SELECT * FROM conversation_summaries WHERE conversation_id = ? ORDER BY created_at`)
			.all(conversation.id) as ConversationSummaryRow[],
		requests: db
			.prepare(
				`SELECT * FROM proxy_requests WHERE conversation_id = ? ORDER BY started_at, step_index`
			)
			.all(conversation.id) as ProxyRequestRow[],
		subagents: children.map((c) => loadTree(db, c, depth + 1))
	};
}

/** Everything to export for one of the user's conversations; undefined when it isn't theirs. */
export function loadConversationExport(
	db: Db,
	userId: string,
	conversationId: string
): ExportedConversation | undefined {
	const conversation = db
		.prepare(`SELECT * FROM conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
		.get(conversationId, userId) as ConversationRow | undefined;
	return conversation ? loadTree(db, conversation, 0) : undefined;
}

// ── formatting ───────────────────────────────────────────────────────────────

function iso(ms: number | null | undefined): string {
	return ms == null ? '—' : new Date(ms).toISOString();
}

/** A fence longer than any backtick run in `body`, so content can't close it. */
function fence(body: string, lang = ''): string {
	const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((m) => m.length));
	const ticks = '`'.repeat(longest + 1);
	return `${ticks}${lang}\n${body}\n${ticks}`;
}

/** JSON with long inline data (base64 payloads, data URLs) elided. */
function json(value: unknown): string {
	return JSON.stringify(
		value,
		(_key, v: unknown) =>
			typeof v === 'string' &&
			v.length > MAX_INLINE_DATA_CHARS &&
			(v.startsWith('data:') || /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 500)))
				? `${v.slice(0, 40)}… [${v.length} chars of inline data elided]`
				: v,
		2
	);
}

function jsonBlock(value: unknown): string {
	if (typeof value === 'string') return fence(value);
	return fence(json(value) ?? 'undefined', 'json');
}

function partLines(part: Record<string, unknown>): string[] {
	const type = String(part.type ?? 'unknown');
	if (type === 'step-start') return ['---- step ----'];
	if (type === 'text') return [String(part.text ?? '')];
	if (type === 'reasoning') {
		const text = String(part.text ?? '').trim();
		return text ? ['**Reasoning:**', fence(text)] : [];
	}
	if (type === 'dynamic-tool' || type.startsWith('tool-')) {
		const name = type === 'dynamic-tool' ? String(part.toolName ?? 'tool') : type.slice(5);
		const lines = [
			`**Tool call \`${name}\`** (state: ${String(part.state ?? '?')}, id: ${String(part.toolCallId ?? '?')})`
		];
		if (part.input !== undefined) lines.push('Input:', jsonBlock(part.input));
		if (part.output !== undefined) lines.push('Output:', jsonBlock(part.output));
		if (part.errorText) lines.push('Error:', fence(String(part.errorText)));
		return lines;
	}
	if (type === 'file') {
		const name = part.filename ? ` ${String(part.filename)}` : '';
		return [`**File**${name} (${String(part.mediaType ?? 'unknown type')})`];
	}
	if (type === 'source-url') {
		return [`**Source:** ${String(part.title ?? '')} <${String(part.url ?? '')}>`];
	}
	// Anything else (data-* parts, future part types): raw, so nothing is lost.
	return [`**Part \`${type}\`:**`, jsonBlock(part)];
}

function messageSection(m: MessageRow, n: number, data: ExportedConversation): string {
	const head = [`### ${n}. ${m.role}`];
	const meta = [`id: ${m.id}`, `at: ${iso(m.created_at)}`, `status: ${m.status}`];
	const branch = data.branches.get(m.id);
	if (branch) meta.push(`version ${branch.index + 1} of ${branch.count}`);
	head.push(`_${meta.join(' · ')}_`);
	if (m.usage_json) head.push('Usage:', fence(json(JSON.parse(m.usage_json)), 'json'));
	if (m.error) head.push('**Error:**', fence(m.error));
	const summary = data.summaries.find((s) => s.through_message_id === m.id);
	let parts: Record<string, unknown>[] = [];
	try {
		parts = JSON.parse(m.parts) as Record<string, unknown>[];
	} catch {
		head.push('(parts are not valid JSON)', fence(m.parts));
	}
	const body = parts.flatMap(partLines);
	const out = [head.join('\n\n'), body.join('\n\n')];
	if (summary) {
		out.push(
			`> **Compaction:** messages up to here were summarised (${iso(summary.created_at)}, ~${summary.token_estimate} tokens). See "Compaction summaries".`
		);
	}
	return out.filter(Boolean).join('\n\n');
}

function requestTable(requests: ProxyRequestRow[]): string {
	const rows = requests.map((r) =>
		[
			iso(r.started_at),
			r.purpose,
			r.step_index,
			`${r.provider_id ?? '?'}/${r.model_id ?? r.requested_model}`,
			r.status,
			r.input_tokens ?? '',
			r.output_tokens ?? '',
			r.cache_read_tokens ?? '',
			r.ttft_ms ?? '',
			r.latency_ms ?? '',
			r.cost_usd == null ? '' : r.cost_usd.toFixed(5),
			r.message_id ?? '',
			(r.error ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 300)
		].join(' | ')
	);
	return [
		'| started | purpose | step | model | status | in tok | out tok | cache read | ttft ms | latency ms | cost $ | message | error |',
		'|---|---|---|---|---|---|---|---|---|---|---|---|---|',
		...rows.map((r) => `| ${r} |`)
	].join('\n');
}

function conversationSection(data: ExportedConversation, level: number): string {
	const c = data.conversation;
	const h = '#'.repeat(level);
	const out: string[] = [];
	const settings: Record<string, unknown> = {
		id: c.id,
		kind: c.kind,
		title: c.title,
		model: c.provider_id && c.model_id ? `${c.provider_id}/${c.model_id}` : null,
		agent: data.agentName ? `${data.agentName} (${c.agent_id})` : c.agent_id,
		origin: c.origin,
		private: c.private === 1,
		memoryEnabled: c.memory_enabled === 1,
		maxSteps: c.max_steps,
		temperature: c.temperature,
		maxTokens: c.max_tokens,
		createdAt: iso(c.created_at),
		updatedAt: iso(c.updated_at),
		messagesOnActivePath: data.messages.length
	};
	if (c.subagent_of) {
		Object.assign(settings, {
			subagentOf: c.subagent_of,
			subagentToolCallId: c.subagent_tool_call_id,
			subagentStatus: c.subagent_status,
			subagentError: c.subagent_error,
			subagentEndedAt: iso(c.subagent_ended_at)
		});
	}
	out.push(`${h}# Settings`, fence(json(settings), 'json'));
	if (c.system_prompt) {
		out.push(
			`${h}# System prompt (conversation-level)`,
			'_The prompt actually sent also includes memory, skills and tool instructions assembled at request time; those are not stored._',
			fence(c.system_prompt)
		);
	}
	out.push(`${h}# Messages (active branch)`);
	if (data.messages.length === 0) out.push('_No messages._');
	data.messages.forEach((m, i) => out.push(messageSection(m, i + 1, data)));
	if (data.summaries.length) {
		out.push(`${h}# Compaction summaries`);
		for (const s of data.summaries) {
			out.push(
				`_${iso(s.created_at)} · through message ${s.through_message_id} · ~${s.token_estimate} tokens_`,
				fence(s.summary_text)
			);
		}
	}
	if (data.requests.length) {
		out.push(
			`${h}# Model requests`,
			'_One row per inference step logged for this conversation (includes titles, compaction and other background calls)._',
			requestTable(data.requests)
		);
	}
	for (const sub of data.subagents) {
		out.push(
			`${h}# Subagent: ${sub.conversation.title || sub.conversation.id}`,
			conversationSection(sub, level + 1)
		);
	}
	return out.join('\n\n');
}

/** The export file's Markdown. */
export function formatConversationExport(data: ExportedConversation, now = Date.now()): string {
	const c = data.conversation;
	return [
		`# Chatty conversation export: ${c.title || '(untitled)'}`,
		[
			`_Exported ${iso(now)} for debugging and analysis._`,
			'',
			'How to read this file:',
			'- "Messages" is the branch the user currently sees, oldest first. "version X of Y" means the message has alternative versions (edits or regenerated replies) that are not included.',
			'- `---- step ----` separates the model calls within one assistant reply. Tool calls show their input and output; long inline data is elided.',
			'- "Model requests" is the raw inference log (tokens, timing, errors) for this conversation.',
			'- Subagents are separate conversations the chat started via `run_subagent`; their transcripts follow at the end.'
		].join('\n'),
		conversationSection(data, 2)
	].join('\n\n');
}

/** A filesystem-safe file name for the export. */
export function exportFileName(c: Pick<ConversationRow, 'title' | 'id'>, now = Date.now()): string {
	const slug =
		c.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'conversation';
	return `chatty-${slug}-${new Date(now).toISOString().slice(0, 10)}-${c.id.slice(0, 8)}.md`;
}
