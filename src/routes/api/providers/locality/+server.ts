import { json } from '@sveltejs/kit';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { isBlockedAddress } from '$lib/server/net/safeFetch.js';
import { resolveProviderBrand } from '$lib/provider-brand.js';
import type { RequestHandler } from './$types';

/**
 * A hint for the provider dialog: whether a base URL looks like it stays on
 * this machine or LAN (localhost, *.local, private addresses, LM Studio or
 * Ollama). It never sets "Can process private data"; the admin decides.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	requireAdmin(locals);
	const raw = url.searchParams.get('url');
	const name = url.searchParams.get('name') ?? '';
	let host: string | null = null;
	if (raw) {
		try {
			host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
		} catch {
			host = null;
		}
	}
	const brand = resolveProviderBrand({ name, baseUrl: raw, type: 'openai-compatible' });
	const looksLocal =
		brand === 'lmstudio' || brand === 'ollama' || (host !== null && (await hostLooksLocal(host)));
	return json({ looksLocal, host });
};

async function hostLooksLocal(host: string): Promise<boolean> {
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
	if (net.isIP(host)) return isBlockedAddress(host);
	try {
		const addresses = await lookup(host, { all: true });
		return addresses.length > 0 && addresses.every((a) => isBlockedAddress(a.address));
	} catch {
		return false;
	}
}
