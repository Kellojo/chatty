// Shared validation for creating/updating MCP servers via /api/mcp-servers.
// These routes are admin-only (requireAdmin). That matters most for `stdio`
// servers, which spawn an arbitrary command on the host: never expose create or
// update of MCP servers to non-admin callers (REST, MCP tools or otherwise).
import { z } from 'zod';
import {
	parseMcpArgs,
	type McpServerRow,
	type UpdateMcpServerInput
} from '../db/repo/mcp-servers.js';

const nameSchema = z
	.string()
	.min(1)
	.max(64)
	.transform((name) =>
		name
			.trim()
			.toLowerCase()
			.replace(/[\s_]+/g, '-')
			.replace(/[^a-z0-9-]/g, '')
			.replace(/^-+|-+$/g, '')
			.replace(/-{2,}/g, '-')
	)
	.pipe(
		z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z0-9][a-z0-9-]*$/)
	);

const commandSchema = z.string().trim().min(1).max(1024);
const argsSchema = z.array(z.string().max(4096)).max(100);
const loadModeSchema = z.enum(['always', 'deferred']);

export const mcpServerCreateSchema = z.discriminatedUnion('transport', [
	z.object({
		name: nameSchema,
		transport: z.enum(['http', 'sse']),
		url: z.url(),
		token: z.string().min(1).nullish(),
		enabled: z.boolean().optional(),
		loadMode: loadModeSchema.optional()
	}),
	z.object({
		name: nameSchema,
		transport: z.literal('stdio'),
		command: commandSchema,
		args: argsSchema.default([]),
		enabled: z.boolean().optional(),
		loadMode: loadModeSchema.optional()
	})
]);

export const mcpServerPatchSchema = z.object({
	name: nameSchema.optional(),
	transport: z.enum(['http', 'sse', 'stdio']).optional(),
	url: z.url().nullish(),
	token: z.string().min(1).nullable().optional(),
	command: commandSchema.nullish(),
	args: argsSchema.optional(),
	enabled: z.boolean().optional(),
	loadMode: loadModeSchema.optional()
});

export type McpServerPatchBody = z.infer<typeof mcpServerPatchSchema>;

export type McpServerPatchResult =
	{ ok: true; value: UpdateMcpServerInput } | { ok: false; error: string };

/**
 * Applies a patch to the stored server and checks the resulting connection
 * settings are complete for its transport. Fields that don't apply to the
 * resulting transport are cleared (e.g. url/token when switching to stdio).
 */
export function resolveMcpServerPatch(
	existing: McpServerRow,
	patch: McpServerPatchBody
): McpServerPatchResult {
	const { transport: patchTransport, url, token, command, args, ...rest } = patch;
	const touchesConnection = [patchTransport, url, token, command, args].some(
		(v) => v !== undefined
	);
	if (existing.builtin === 1 || !touchesConnection) return { ok: true, value: rest };

	const transport =
		patchTransport ?? (existing.transport === 'builtin' ? undefined : existing.transport);
	if (!transport) return { ok: false, error: 'Transport is required' };

	if (transport === 'stdio') {
		const nextCommand = command !== undefined ? command : existing.command;
		if (!nextCommand) return { ok: false, error: 'A stdio server requires a command' };
		const nextArgs = args ?? (existing.transport === 'stdio' ? parseMcpArgs(existing.args) : []);
		return {
			ok: true,
			value: { ...rest, transport, command: nextCommand, args: nextArgs, url: null, token: null }
		};
	}

	const nextUrl = url !== undefined ? url : existing.url;
	if (!nextUrl) return { ok: false, error: `An ${transport} server requires a url` };
	// Keep the stored token unless the patch explicitly sets or clears it.
	return {
		ok: true,
		value: {
			...rest,
			transport,
			url: nextUrl,
			command: null,
			args: [],
			...(token !== undefined ? { token } : {})
		}
	};
}
