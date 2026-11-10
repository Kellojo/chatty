import { z } from 'zod';

const boolFromString = (fallback: 'true' | 'false') =>
	z
		.enum(['true', 'false'])
		.default(fallback)
		.transform((v) => v === 'true');

function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone });
		return true;
	} catch {
		return false;
	}
}

const schema = z.object({
	DATABASE_PATH: z.string().default('./data/ai-chat.db'),
	MEMORY_VOLUME: z.string().default('./memory'),
	SKILLS_VOLUME: z.string().default('./skills'),
	DOCUMENTS_VOLUME: z.string().default('./documents'),
	WORKSPACES_VOLUME: z.string().default('./workspaces'),
	WORKSPACE_GC_DAYS: z.coerce.number().int().min(1).default(30),
	TZ: z
		.string()
		.default('UTC')
		.refine(isValidTimeZone, { message: 'must be a valid IANA time zone (e.g. Europe/Berlin)' }),
	ENABLE_SIGNUP: boolFromString('true'),
	ENABLE_PASSWORD_LOGIN: boolFromString('true'),
	OIDC_ONLY: boolFromString('false'),
	OIDC_ISSUER: z.string().url().optional(),
	OIDC_CLIENT_ID: z.string().optional(),
	OIDC_CLIENT_SECRET: z.string().optional(),
	OIDC_SCOPES: z.string().default('openid profile email'),
	AUTO_PROMOTE_FIRST_USER: boolFromString('true'),
	AGENT_MAX_STEPS: z.coerce.number().int().min(1).default(25),
	CHAT_COMPACT_TOKENS: z.coerce.number().int().min(0).default(60000),
	CHAT_COMPACT_KEEP_MESSAGES: z.coerce.number().int().min(2).default(10),
	MAX_ATTACHMENT_SIZE_MB: z.coerce.number().int().min(1).default(50),
	SETTINGS_MCP_WRITE: boolFromString('false'),
	// Chats untouched for this many days are settled (hidden from the sidebar). 0 disables.
	CONVERSATION_AUTO_SETTLE_DAYS: z.coerce.number().int().min(0).default(7),
	// An agent's unanswered question is dismissed after this many days. 0 disables.
	AGENT_QUESTION_TTL_DAYS: z.coerce.number().int().min(0).default(7),
	// Settled agent-run chats the user never replied to are deleted after this many days. 0 disables.
	AGENT_RUN_CHAT_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
	// Lets agent fetch tools (webfetch, fs_curl) reach localhost, private LAN and
	// link-local/metadata addresses. Off by default to prevent SSRF.
	ALLOW_PRIVATE_NETWORK_FETCH: boolFromString('false'),
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
