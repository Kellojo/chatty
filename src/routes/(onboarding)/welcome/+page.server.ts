import { isPrivateDataEnabled } from '$lib/server/privacy/feature.js';
import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { listMcpServers } from '$lib/server/db/repo/mcp-servers.js';
import { findRoleModel, listModels, resolveDefaultChatModel } from '$lib/server/db/repo/models.js';
import { getProvider } from '$lib/server/db/repo/providers.js';
import { getOnboarding, getUserSettings } from '$lib/server/db/repo/user-settings.js';
import { listUsers } from '$lib/server/db/repo/users.js';
import { getWebSearchInfo } from '$lib/server/websearch/service.js';
import { buildOnboardingSteps, resumeStep } from '$lib/onboarding.js';
import { safeRedirectPath } from '$lib/redirect-to.js';
import { DEFAULT_SUGGESTIONS } from '$lib/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(302, `/login?redirectTo=${encodeURIComponent('/welcome')}`);
	const user = locals.user;
	const db = getDb();
	const next = safeRedirectPath(url.searchParams.get('next'));
	const replay = url.searchParams.has('replay');
	const onboarding = getOnboarding(db, user.id);
	if (!replay && onboarding.status !== 'pending') redirect(303, next);

	// Read now rather than at signup: the first account is promoted after it's created.
	const isAdmin = (user as { role?: string }).role === 'admin';
	const chatModel = resolveDefaultChatModel(db);
	const steps = buildOnboardingSteps({ isAdmin, hasUsableChatModel: chatModel !== null });
	const settings = getUserSettings(db, user.id);

	return {
		user: { name: user.name, email: user.email },
		isAdmin,
		replay,
		next,
		steps,
		initialStep: resumeStep(steps, replay ? null : onboarding.step),
		theme: settings.theme,
		globalInstructions: settings.globalInstructions,
		suggestions: (settings.suggestions.length > 0
			? settings.suggestions
			: DEFAULT_SUGGESTIONS
		).slice(0, 3),
		defaultModel: chatModel ? describeModel(chatModel) : null,
		setup: isAdmin ? instanceSetup() : null,
		/** Whether chats, notes and agents can be marked private here (Settings → Private data). */
		privateDataEnabled: isPrivateDataEnabled(db)
	};

	function describeModel(row: NonNullable<typeof chatModel>) {
		const provider = getProvider(db, row.provider_id);
		return {
			id: row.id,
			modelId: row.model_id,
			displayName: row.display_name,
			provider: provider
				? { name: provider.name, baseUrl: provider.base_url, type: provider.type }
				: null
		};
	}

	/** What else an admin may want to set up; the last screen links to each. */
	function instanceSetup() {
		const web = getWebSearchInfo(db);
		return {
			webSearch: Boolean(web.searxng.url || web.brave.source || web.perplexity.source),
			voice: Boolean(findRoleModel(db, 'speech-to-text') || findRoleModel(db, 'text-to-speech')),
			tools: listMcpServers(db).some((server) => server.builtin === 0),
			people: listUsers(db).length > 1,
			modelCount: listModels(db).filter((m) => m.enabled === 1).length
		};
	}
};
