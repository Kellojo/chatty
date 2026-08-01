import { z } from 'zod';

const boolFromString = (fallback: 'true' | 'false') =>
	z
		.enum(['true', 'false'])
		.default(fallback)
		.transform((v) => v === 'true');

const schema = z.object({
	DATABASE_PATH: z.string().default('./data/ai-chat.db'),
	MEMORY_VOLUME: z.string().default('./memory'),
	SKILLS_VOLUME: z.string().default('./skills'),
	DOCUMENTS_VOLUME: z.string().default('./documents'),
	WORKSPACES_VOLUME: z.string().default('./workspaces'),
	WORKSPACE_GC_DAYS: z.coerce.number().int().min(1).default(30),
	TZ: z.string().default('UTC'),
	ENABLE_SIGNUP: boolFromString('true'),
	ENABLE_PASSWORD_LOGIN: boolFromString('true'),
	OIDC_ONLY: boolFromString('false'),
	OIDC_ISSUER: z.string().url().optional(),
	OIDC_CLIENT_ID: z.string().optional(),
	OIDC_CLIENT_SECRET: z.string().optional(),
	OIDC_SCOPES: z.string().default('openid profile email'),
	AUTO_PROMOTE_FIRST_USER: boolFromString('true'),
	LM_STUDIO_BASE_URL: z.string().default('http://localhost:1234'),
	AGENT_MAX_STEPS: z.coerce.number().int().min(1).default(25),
	CHAT_COMPACT_TOKENS: z.coerce.number().int().min(0).default(60000),
	CHAT_COMPACT_KEEP_MESSAGES: z.coerce.number().int().min(2).default(10),
	MAX_ATTACHMENT_SIZE_MB: z.coerce.number().int().min(1).default(50),
	SETTINGS_MCP_WRITE: boolFromString('false'),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	ORIGIN: z.string().url().optional(),
	APP_SECRET: z.string().min(16).optional()
});

export type Config = z.infer<typeof schema>;

function load(): Config {
	const parsed = schema.safeParse(process.env);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new Error(`Invalid environment configuration: ${issues}`);
	}
	const c = parsed.data;
	if (c.OIDC_ONLY) {
		if (!c.OIDC_ISSUER || !c.OIDC_CLIENT_ID || !c.OIDC_CLIENT_SECRET) {
			throw new Error('OIDC_ONLY=true requires OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET');
		}
	}
	return c;
}

export const config = load();
