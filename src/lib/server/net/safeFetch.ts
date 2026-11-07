import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';
import { config } from '../config.js';

// Guards fetches whose URL comes from a model or user (webfetch, fs_curl)
// against server-side request forgery: loopback, private LAN, link-local
// (incl. cloud metadata at 169.254.169.254), CGNAT and other special ranges.

const blocked = new net.BlockList();
for (const [addr, prefix] of [
	['0.0.0.0', 8], // "this" network
	['10.0.0.0', 8],
	['100.64.0.0', 10], // CGNAT
	['127.0.0.0', 8],
	['169.254.0.0', 16], // link-local, cloud metadata
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4] // reserved, broadcast
] as const) {
	blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
	['::', 128],
	['::1', 128],
	['64:ff9b::', 96], // NAT64
	['100::', 64],
	['2001::', 32], // Teredo
	['2001:db8::', 32],
	['2002::', 16], // 6to4
	['fc00::', 7], // unique local
	['fe80::', 10], // link-local
	['fec0::', 10],
	['ff00::', 8] // multicast
] as const) {
	blocked.addSubnet(addr, prefix, 'ipv6');
}

export function isBlockedAddress(ip: string): boolean {
	const family = net.isIP(ip);
	if (family === 4) return blocked.check(ip, 'ipv4');
	if (family !== 6) return true;
	// IPv4-mapped addresses (::ffff:a.b.c.d or ::ffff:XXXX:XXXX) are judged by
	// the v4 rules. (A ::ffff:0:0/96 subnet can't be used: BlockList applies
	// it to plain IPv4 addresses too, which would block everything.)
	const v4 = mappedV4(ip);
	if (v4) return blocked.check(v4, 'ipv4');
	return blocked.check(ip, 'ipv6');
}

export class BlockedAddressError extends Error {
	constructor(host: string, address: string) {
		super(`refusing to connect to ${host} (${address}): private or reserved address`);
		this.name = 'BlockedAddressError';
	}
}

// Addresses that are never a legitimate target even for services the admin
// expects on the LAN/tailnet (e.g. T3 coding environments): link-local (incl.
// cloud metadata at 169.254.169.254), unspecified and multicast.
const alwaysBlocked = new net.BlockList();
for (const [addr, prefix] of [
	['0.0.0.0', 8],
	['169.254.0.0', 16],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
] as const) {
	alwaysBlocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
	['::', 128],
	['fe80::', 10],
	['ff00::', 8]
] as const) {
	alwaysBlocked.addSubnet(addr, prefix, 'ipv6');
}

/** Link-local / metadata / unspecified / multicast, incl. IPv4-mapped forms. */
export function isLinkLocalOrReserved(ip: string): boolean {
	const family = net.isIP(ip);
	if (family === 4) return alwaysBlocked.check(ip, 'ipv4');
	if (family !== 6) return true;
	const v4 = mappedV4(ip);
	if (v4) return alwaysBlocked.check(v4, 'ipv4');
	return alwaysBlocked.check(ip, 'ipv6');
}

function mappedV4(ip: string): string | null {
	const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (dotted) return dotted[1];
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
	if (!hex) return null;
	const hi = parseInt(hex[1], 16);
	const lo = parseInt(hex[2], 16);
	return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

// Validating inside the socket's DNS lookup (rather than resolving up front)
// checks the exact address being connected to, so DNS rebinding can't swap in
// a private address between the check and the connection.
const lookupGuardedBy =
	(isBad: (ip: string) => boolean) =>
	(
		hostname: string,
		options: dns.LookupOptions,
		callback: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void
	): void => {
		dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
			if (error) return callback(error, '');
			const bad = addresses.find((a) => isBad(a.address));
			if (bad) return callback(new BlockedAddressError(hostname, bad.address), '');
			if (addresses.length === 0) return callback(new Error(`no addresses for ${hostname}`), '');
			if (options.all) return callback(null, addresses);
			callback(null, addresses[0].address, addresses[0].family);
		});
	};

const guardedAgent = new Agent({ connect: { lookup: lookupGuardedBy(isBlockedAddress) } });

/**
 * Dispatcher for user-configured services that may legitimately live on
 * loopback/LAN/tailnet addresses: only link-local (cloud metadata) and other
 * never-valid ranges are refused, checked at connect time.
 */
export const linkLocalGuardedAgent = new Agent({
	connect: { lookup: lookupGuardedBy(isLinkLocalOrReserved) }
});

const MAX_REDIRECTS = 5;
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function checkUrl(url: URL): void {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`unsupported protocol: ${url.protocol}`);
	}
	// IP-literal hosts skip DNS lookup, so check them here.
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (net.isIP(host) && isBlockedAddress(host)) throw new BlockedAddressError(host, host);
}

/**
 * GET-style `fetch` for untrusted URLs: http(s) only, and every hop (including
 * redirects) must resolve to a public address unless
 * ALLOW_PRIVATE_NETWORK_FETCH is set.
 */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
	if (config.ALLOW_PRIVATE_NETWORK_FETCH) return fetch(input, init);
	const follow = (init.redirect ?? 'follow') === 'follow';
	let url = new URL(input);
	const headers = new Headers(init.headers);
	for (let hop = 0; ; hop++) {
		checkUrl(url);
		let res: Response;
		try {
			res = await fetch(url, {
				...init,
				headers,
				redirect: 'manual',
				// undici-specific option honoured by Node's built-in fetch.
				dispatcher: guardedAgent
			} as RequestInit);
		} catch (e) {
			// Surface the guard's reason instead of undici's generic "fetch failed".
			const cause = (e as { cause?: unknown }).cause;
			throw cause instanceof BlockedAddressError ? cause : e;
		}
		const location = res.headers.get('location');
		if (!follow || res.status < 300 || res.status >= 400 || !location) return res;
		await res.body?.cancel();
		if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
		const next = new URL(location, url);
		// Like browsers, don't forward credentials to a different origin.
		if (next.origin !== url.origin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
		url = next;
	}
}
