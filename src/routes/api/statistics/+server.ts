import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { listProxyRequests } from '$lib/server/db/repo/proxy-requests.js';
import { listProviders } from '$lib/server/db/repo/providers.js';
import { listModels } from '$lib/server/db/repo/models.js';
import { listModelMappings } from '$lib/server/db/repo/model-mappings.js';
import { conversationDailyCounts, countConversations } from '$lib/server/db/repo/conversations.js';
import type { RequestHandler } from './$types';

function fillDateRange(
	rows: { date: string; count: number }[],
	days: number
): { date: string; count: number }[] {
	const map = new Map(rows.map((r) => [r.date, r.count]));
	const results: { date: string; count: number }[] = [];
	const now = new Date();
	for (let i = 0; i < days; i++) {
		const d = new Date(now);
		d.setDate(d.getDate() - i);
		const date = d.toISOString().slice(0, 10);
		results.push({ date, count: map.get(date) ?? 0 });
	}
	return results;
}

export const GET: RequestHandler = () => {
	const db = getDb();
	const proxyRequests = listProxyRequests(db, {}, 1, 0).total;
	const providers = listProviders(db).length;
	const customMappings = listModelMappings(db).length;
	const overallModels = listModels(db).length;
	const conversations = countConversations(db);
	const conversationsDaily = fillDateRange(conversationDailyCounts(db, 365), 365);

	return json({
		proxyRequests,
		providers,
		customMappings,
		overallModels,
		conversations,
		conversationsDaily
	});
};
