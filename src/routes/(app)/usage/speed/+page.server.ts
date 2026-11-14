import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { proxyRequestSpeedSamples } from '$lib/server/db/repo/proxy-requests.js';
import { listProviders } from '$lib/server/db/repo/providers.js';
import { summarizeSpeed } from '$lib/inference-speed.js';
import { firstPaygRequest, usageWindow } from '../usage-data.server.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const user = requireUser(locals);
	const db = getDb();
	const window = usageWindow(url, Date.now(), firstPaygRequest(db, user.id));
	const samples = proxyRequestSpeedSamples(db, {
		userId: user.id,
		from: window.fromMs,
		to: window.toMs
	});
	return {
		period: window.period,
		rangeLabel: window.label,
		speed: summarizeSpeed(samples),
		// Same provider colors as the Overview tab.
		colorSlots: Object.fromEntries(listProviders(db).map((p, i) => [p.id, i])) as Record<
			string,
			number
		>
	};
};
