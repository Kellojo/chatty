import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	MAX_SEARCH_PAGE_SIZE,
	SEARCH_PAGE_SIZE,
	searchConversations,
	toPublic
} from '$lib/server/db/repo/conversations.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return json({ conversations: [] });
	const limit = intParam(url, 'limit', SEARCH_PAGE_SIZE, 1, MAX_SEARCH_PAGE_SIZE);
	const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
	return json({
		conversations: searchConversations(getDb(), user.id, q, { limit, offset }).map(toPublic)
	});
};

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
	const value = Number(url.searchParams.get(name) ?? '');
	if (!url.searchParams.has(name) || !Number.isInteger(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
