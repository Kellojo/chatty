import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	finishOnboarding,
	getOnboarding,
	setOnboardingStep
} from '$lib/server/db/repo/user-settings.js';
import { ONBOARDING_STEPS } from '$lib/onboarding.js';
import type { RequestHandler } from './$types';

const putSchema = z.union([
	z.object({ step: z.enum(ONBOARDING_STEPS) }),
	z.object({ status: z.enum(['done', 'skipped']) })
]);

/** Progress through the welcome flow: `{ step }` while in it, `{ status }` to leave it. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = putSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid request body' });
	const db = getDb();
	if ('step' in parsed.data) setOnboardingStep(db, user.id, parsed.data.step);
	else finishOnboarding(db, user.id, parsed.data.status);
	return json({ onboarding: getOnboarding(db, user.id) });
};
