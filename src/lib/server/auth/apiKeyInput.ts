import { z } from 'zod';

export const API_KEY_SCOPES = ['agents:run', 'llm:invoke', 'mcp:use'] as const;

/** A key's MCP gateway access (see McpKeyAccess); null resets it to the default servers. */
export const mcpAccessSchema = z
	.array(
		z.object({
			serverId: z.string().min(1).max(100),
			tools: z.array(z.string().min(1).max(200)).max(500).nullable()
		})
	)
	.max(200)
	.nullable();

export const apiKeyCreateSchema = z.object({
	label: z.string().trim().min(1).max(100),
	scopes: z.array(z.enum(API_KEY_SCOPES)).default(['agents:run']),
	mcpAccess: mcpAccessSchema.optional()
});

export const apiKeyUpdateSchema = z
	.object({
		label: z.string().trim().min(1).max(100),
		scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
		mcpAccess: mcpAccessSchema
	})
	.partial();
