import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	updateNotificationTriggers,
	updatePushTriggers,
	getUserSettings,
	setUserSetting,
	deleteUserSetting
} from '$lib/server/db/repo/user-settings.js';
import {
	MAX_FAVORITE_MODELS,
	MAX_GLOBAL_INSTRUCTIONS_LENGTH,
	MAX_SUGGESTIONS,
	THEMES,
	TIME_FORMATS
} from '$lib/user-settings.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ settings: getUserSettings(getDb(), user.id) });
};

const suggestionList = z.array(z.string().trim().min(1).max(200)).max(MAX_SUGGESTIONS);

const triggerPatch = z
	.object({
		replies: z.boolean(),
		needsYou: z.boolean(),
		codingFinished: z.boolean(),
		failures: z.boolean(),
		agentRuns: z.boolean()
	})
	.partial();

const putSchema = z
	.object({
		theme: z.enum(THEMES).optional(),
		suggestions: suggestionList.optional(),
		codingSuggestions: suggestionList.optional(),
		globalInstructions: z.string().trim().max(MAX_GLOBAL_INSTRUCTIONS_LENGTH).optional(),
		timeFormat: z.enum(TIME_FORMATS).optional(),
		sidebarOpen: z.boolean().optional(),
		favoriteModels: z
			.array(z.string().min(3).max(500).includes('/'))
			.max(MAX_FAVORITE_MODELS)
			.optional(),
		notificationTriggers: triggerPatch.optional(),
		pushTriggers: triggerPatch.optional()
	})
	.refine(
		(data) =>
			data.theme !== undefined ||
			data.suggestions !== undefined ||
			data.codingSuggestions !== undefined ||
			data.globalInstructions !== undefined ||
			data.timeFormat !== undefined ||
			data.sidebarOpen !== undefined ||
			data.favoriteModels !== undefined ||
			data.notificationTriggers !== undefined ||
			data.pushTriggers !== undefined,
		{ message: 'Nothing to update' }
	);

export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = putSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid request body' });
	const db = getDb();
	if (parsed.data.theme !== undefined) setUserSetting(db, user.id, 'theme', parsed.data.theme);
	if (parsed.data.timeFormat !== undefined) {
		setUserSetting(db, user.id, 'timeFormat', parsed.data.timeFormat);
	}
	if (parsed.data.sidebarOpen !== undefined) {
		setUserSetting(db, user.id, 'sidebarOpen', parsed.data.sidebarOpen);
	}
	if (parsed.data.favoriteModels !== undefined) {
		setUserSetting(db, user.id, 'favoriteModels', [...new Set(parsed.data.favoriteModels)]);
	}
	if (parsed.data.notificationTriggers !== undefined) {
		updateNotificationTriggers(db, user.id, parsed.data.notificationTriggers);
	}
	if (parsed.data.pushTriggers !== undefined) {
		updatePushTriggers(db, user.id, parsed.data.pushTriggers);
	}
	if (parsed.data.suggestions !== undefined) {
		setUserSetting(db, user.id, 'suggestions', parsed.data.suggestions);
	}
	if (parsed.data.codingSuggestions !== undefined) {
		setUserSetting(db, user.id, 'codingSuggestions', parsed.data.codingSuggestions);
	}
	if (parsed.data.globalInstructions !== undefined) {
		if (parsed.data.globalInstructions === '') {
			deleteUserSetting(db, user.id, 'globalInstructions');
		} else {
			setUserSetting(db, user.id, 'globalInstructions', parsed.data.globalInstructions);
		}
	}
	return json({ settings: getUserSettings(db, user.id) });
};
