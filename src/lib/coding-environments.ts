// Client-safe types for coding environments (remote T3 Code servers) and the
// provider usage Chatty mirrors from them.

export type CodingEnvironmentStatus = 'unknown' | 'online' | 'error';

export interface CodingEnvironment {
	id: string;
	name: string;
	baseUrl: string;
	enabled: boolean;
	status: CodingEnvironmentStatus;
	serverVersion: string | null;
	/** Name the remote server reports for itself (e.g. its hostname). */
	environmentLabel: string | null;
	lastError: string | null;
	lastCheckedAt: number | null;
	lastSyncedAt: number | null;
	createdAt: number;
}

export type UsageWindowKind = 'session' | 'weekly' | 'monthly' | 'other';

/** One usage-limit bar (e.g. Claude "Session" 42%) for a provider account. */
export interface CodingUsageLimitWindow {
	environmentId: string;
	accountId: string;
	provider: string;
	accountLabel: string;
	accountEmail: string | null;
	accountPlan: string | null;
	windowId: string;
	windowKind: UsageWindowKind;
	windowLabel: string;
	usedPercent: number;
	resetsAt: number | null;
	checkedAt: number;
}

export interface CodingUsageDailyRow {
	environmentId: string;
	day: string;
	provider: string;
	model: string;
	inputTokens: number;
	cachedInputTokens: number;
	cacheCreationTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	/** API-equivalent estimate unless the provider reported cost itself. */
	costUsd: number;
	/** False when some records had no known price (cost is a lower bound). */
	priced: boolean;
	sessions: number;
}

// ── coding tasks ─────────────────────────────────────────────────────────

/** Cookie remembering whether the new-chat page opens in chat or coding mode. */
export const START_MODE_COOKIE = 'chatty_start_mode';

export type CodingTaskStatus =
	'starting' | 'running' | 'awaiting_input' | 'idle' | 'failed' | 'interrupted';

export type CodingWorkspaceMode = 'worktree' | 'local';

/** How much the coding agent may do without asking (maps to T3 runtime modes). */
export const CODING_AUTONOMY_VALUES = ['supervised', 'auto-edits', 'auto', 'full-access'] as const;
export type CodingAutonomy = (typeof CODING_AUTONOMY_VALUES)[number];

/** Where a coding agent's runs start: everything needed to create a coding task. */
export interface AgentCodingTarget {
	environmentId: string;
	projectId: string;
	/** Project title when the target was saved (display only; the id is authoritative). */
	projectTitle: string;
	providerInstanceId: string;
	model: string;
	autonomy: CodingAutonomy;
	workspaceMode: CodingWorkspaceMode;
	/** Base branch for worktree runs; null for the project checkout. */
	baseBranch: string | null;
}

export interface CodingPendingOption {
	id: string;
	label: string;
	/** Explanation of what choosing this option means (questions only). */
	description?: string;
}

/** An approval or question from the coding agent waiting on the user. */
export interface CodingPendingRequest {
	requestId: string;
	kind: 'approval' | 'question';
	/** T3 question id the answer is keyed by (questions only). */
	questionId?: string;
	title: string;
	detail: string | null;
	/** Approval decisions or question choices; empty for free-text questions. */
	options: CodingPendingOption[];
	allowFreeText: boolean;
	createdAt: number;
}

export interface CodingConversation {
	conversationId: string;
	environmentId: string | null;
	projectId: string;
	projectTitle: string;
	threadId: string | null;
	providerInstanceId: string;
	model: string;
	runtimeMode: string;
	workspaceMode: CodingWorkspaceMode;
	baseBranch: string | null;
	branch: string | null;
	prUrl: string | null;
	status: CodingTaskStatus;
	pendingRequest: CodingPendingRequest | null;
	lastError: string | null;
	/** Start of the agent run in progress (ms), null when nothing runs. */
	runStartedAt: number | null;
	/** Lines changed on the task's branch / working tree, null until known. */
	diff: CodingDiffStat | null;
}

export interface CodingDiffStat {
	insertions: number;
	deletions: number;
}

/** What the conversation list shows about a coding task. */
export interface CodingConversationSummary {
	projectTitle: string;
	status: CodingTaskStatus;
	/** Start of the agent run in progress (ms), null when nothing runs. */
	runStartedAt: number | null;
	diff: CodingDiffStat | null;
}

/** A provider instance + model slug on a T3 server. */
export interface CodingModelRef {
	providerInstanceId: string;
	model: string;
}

export interface CodingProjectOption {
	id: string;
	title: string;
	defaultBranch: string | null;
	isGitRepo: boolean;
	/** T3's default model for new threads in this project (already resolved to an available one). */
	defaultModel: CodingModelRef | null;
	/** Per-project overrides of the environment defaults, from T3's settings. */
	defaultAutonomy: CodingAutonomy | null;
	defaultWorkspaceMode: CodingWorkspaceMode | null;
}

export interface CodingModelOption {
	providerInstanceId: string;
	provider: string;
	providerLabel: string;
	model: string;
	label: string;
	/** Starred in T3. */
	favorite: boolean;
}

export interface ParsedEnvironmentUrl {
	/** Server base URL without the `/pair` path, query or fragment. */
	baseUrl: string;
	/** One-time pairing code from a `…/pair#token=…` link, if present. */
	pairingToken: string | null;
}

/**
 * Splits a pasted T3 Code URL into its server base URL and pairing token.
 * Accepts plain base URLs and pairing links (`https://host/pair#token=abc`,
 * also behind a path prefix such as `https://host/t3/pair#token=abc`).
 * Returns null when the input isn't an http(s) URL.
 */
export function parseEnvironmentUrl(input: string): ParsedEnvironmentUrl | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	const fromHash = new URLSearchParams(url.hash.replace(/^#/, '')).get('token');
	const pairingToken = (fromHash ?? url.searchParams.get('token'))?.trim() || null;
	const path = url.pathname.replace(/\/+$/, '').replace(/\/pair$/, '');
	return { baseUrl: `${url.origin}${path}`, pairingToken };
}

/**
 * The repository name from a clone source: `owner/repo`, an HTTPS URL
 * (`https://github.com/owner/repo.git`) or an SSH URL (`git@host:owner/repo.git`).
 * Returns null when no name can be derived.
 */
export function repositoryName(source: string): string | null {
	const path = source
		.trim()
		.replace(/[?#].*$/, '')
		.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '') // scheme://host
		.replace(/^[^@/\s]+@[^:/]+:/, '') // user@host:
		.replace(/\/+$/, '');
	const last = path
		.split('/')
		.pop()
		?.replace(/\.git$/i, '');
	return last && /^[\w.-]+$/.test(last) && last !== '.' && last !== '..' ? last : null;
}

const PROVIDER_LABELS: Record<string, string> = {
	claude: 'Claude',
	claudeAgent: 'Claude',
	codex: 'Codex',
	cursor: 'Cursor',
	opencode: 'OpenCode',
	grok: 'Grok',
	antigravity: 'Antigravity',
	pi: 'Pi',
	muse: 'Muse'
};

export function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}
