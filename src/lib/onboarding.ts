/**
 * First-run onboarding: which screens a new user sees and where they resume.
 * Shared by the server (step list, gate) and the /welcome page; no server imports.
 */

export const ONBOARDING_STEPS = ['welcome', 'model', 'personalize', 'concepts', 'ready'] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_STATUSES = ['none', 'pending', 'done', 'skipped'] as const;

/** `none`: no onboarding (accounts from before it existed); `pending`: shown on next visit. */
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export interface OnboardingState {
	status: OnboardingStatus;
	/** The last step the user reached, for resuming after a reload. */
	step: OnboardingStep | null;
}

export const STEP_LABELS: Record<OnboardingStep, string> = {
	welcome: 'Welcome',
	model: 'Connect a model',
	personalize: 'Make it yours',
	concepts: 'How it works',
	ready: 'Ready'
};

export function isOnboardingStep(value: unknown): value is OnboardingStep {
	return ONBOARDING_STEPS.includes(value as OnboardingStep);
}

/** A stored value as a valid state; anything unexpected means no onboarding. */
export function parseOnboardingState(value: unknown): OnboardingState {
	if (typeof value !== 'object' || value === null) return { status: 'none', step: null };
	const { status, step } = value as { status?: unknown; step?: unknown };
	if (!ONBOARDING_STATUSES.includes(status as OnboardingStatus)) {
		return { status: 'none', step: null };
	}
	return { status: status as OnboardingStatus, step: isOnboardingStep(step) ? step : null };
}

/**
 * The screens this user sees. Only an admin can connect a provider, and only
 * when no chat model is usable yet; everyone else skips straight past it.
 */
export function buildOnboardingSteps(input: {
	isAdmin: boolean;
	hasUsableChatModel: boolean;
}): OnboardingStep[] {
	return ONBOARDING_STEPS.filter(
		(step) => step !== 'model' || (input.isAdmin && !input.hasUsableChatModel)
	);
}

/**
 * Where to pick up: the saved step if it is still part of the flow (a model
 * connected in another tab removes `model`), else the next step that is.
 */
export function resumeStep(steps: OnboardingStep[], saved: OnboardingStep | null): OnboardingStep {
	if (saved === null) return steps[0];
	if (steps.includes(saved)) return saved;
	const order = ONBOARDING_STEPS.indexOf(saved);
	return steps.find((step) => ONBOARDING_STEPS.indexOf(step) > order) ?? steps[0];
}

/**
 * A sensible first default among freshly synced models, chosen by capability
 * rather than by name (names go stale): tools and vision, then tools, then any.
 */
export function pickDefaultChatModel<T extends { modelId: string; capabilities: string[] }>(
	models: T[]
): T | undefined {
	// Providers that don't describe their models tag every one as chat, embeddings
	// and speech models included; leave those out unless nothing else is left.
	const tagged = models.filter((m) => m.capabilities.includes('chat'));
	const conversational = tagged.filter((m) => !NON_CHAT_MODEL_ID.test(m.modelId));
	const chat = conversational.length > 0 ? conversational : tagged;
	const has = (m: T, ...caps: string[]) => caps.every((cap) => m.capabilities.includes(cap));
	return (
		chat.find((m) => has(m, 'tool_use', 'vision')) ??
		chat.find((m) => has(m, 'tool_use')) ??
		chat[0]
	);
}

const NON_CHAT_MODEL_ID =
	/embed|whisper|tts|transcri|dall-?e|image|moderation|rerank|realtime|audio|speech|search/i;

/** Longest `?prompt=` the home page pre-fills from onboarding. */
export const MAX_PREFILL_PROMPT_LENGTH = 2000;
