import type { Tool, UIMessage } from 'ai';

/**
 * Character-share estimates of what makes up a model prompt. These are used
 * to show the relative weight of each contributor (system prompt, skills,
 * tools, messages) as a percentage of the input — not as token counts.
 * They are rough, order-of-magnitude numbers, never used for billing.
 */

/** Fixed char budget for a file/attachment part (id note + image overhead). */
export const FILE_PART_CHARS = 64;

function safeJsonLength(value: unknown): number {
	if (value === undefined) return 0;
	try {
		const text = JSON.stringify(value);
		return text ? text.length : 0;
	} catch {
		return 0;
	}
}

/**
 * Measure a tool input schema in the form providers serialize it:
 * plain JSON Schema objects, AI SDK `jsonSchema()` wrappers, or zod schemas
 * (via `toJSONSchema`) are all handled.
 */
function schemaChars(schema: unknown): number {
	if (schema === null || schema === undefined) return 2; // {}
	const s = schema as {
		jsonSchema?: unknown;
		validate?: unknown;
		toJSONSchema?: (options?: { target?: string }) => unknown;
	};
	// AI SDK schema wrapper: `{ [symbol]: true, get jsonSchema(), validate }`.
	if (
		typeof s.validate === 'function' &&
		typeof s.jsonSchema === 'object' &&
		s.jsonSchema !== null
	) {
		return safeJsonLength(s.jsonSchema);
	}
	if (typeof s.toJSONSchema === 'function') {
		try {
			return safeJsonLength(s.toJSONSchema());
		} catch {
			return 0;
		}
	}
	return safeJsonLength(schema);
}

/**
 * Estimate the character cost of the tool definitions sent with the prompt
 * (tool name + description + serialized input schema, per tool).
 */
export function estimateToolChars(tools: Record<string, Tool> | undefined | null): number {
	if (!tools) return 0;
	let total = 0;
	for (const [name, tool] of Object.entries(tools)) {
		const t = tool as
			{ description?: unknown; inputSchema?: unknown; parameters?: unknown } | undefined;
		const description = typeof t?.description === 'string' ? t.description : '';
		total += name.length + description.length + schemaChars(t?.inputSchema ?? t?.parameters);
	}
	return total;
}

/**
 * Estimate the character cost of a set of UI messages (their text, tool
 * call inputs/results, and a fixed budget per file part).
 */
export function estimateMessagesChars(messages: UIMessage[]): number {
	let total = 0;
	for (const message of messages) {
		for (const part of message.parts) {
			const p = part as {
				type: string;
				text?: unknown;
				data?: unknown;
				input?: unknown;
				output?: unknown;
			};
			if (p.type === 'file') {
				// attachments are billed as image/file tokens, not their raw bytes
				total += FILE_PART_CHARS;
				continue;
			}
			if (typeof p.text === 'string') total += p.text.length;
			if (p.data !== undefined) total += safeJsonLength(p.data);
			if (p.input !== undefined) total += safeJsonLength(p.input);
			if (p.output !== undefined) total += safeJsonLength(p.output);
		}
	}
	return total;
}
