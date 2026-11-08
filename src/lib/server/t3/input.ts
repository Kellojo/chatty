import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { parseEnvironmentUrl } from '$lib/coding-environments.js';
import type { Db } from '../db/index.js';
import { findDuplicateCodingEnvironment } from '../db/repo/coding-environments.js';
import { exchangePairingToken, fetchEnvironmentDescriptor } from './client.js';

/**
 * A T3 Code server URL, either a base URL (`https://devbox.tailnet.ts.net`) or a
 * pairing link (`https://devbox.tailnet.ts.net/pair#token=…`).
 */
const environmentUrlSchema = z
	.string()
	.trim()
	.max(4096)
	.transform((value, ctx) => {
		const parsed = parseEnvironmentUrl(value);
		if (!parsed) {
			ctx.addIssue({ code: 'custom', message: 'Enter an http(s) URL' });
			return z.NEVER;
		}
		return parsed;
	});

const nameSchema = z.string().trim().min(1).max(64);
const tokenSchema = z.string().trim().min(1).max(8192);

export const environmentCreateSchema = z
	.object({
		name: nameSchema,
		baseUrl: environmentUrlSchema,
		token: tokenSchema.optional(),
		pairingToken: tokenSchema.optional(),
		enabled: z.boolean().optional()
	})
	.refine((v) => v.token || v.pairingToken || v.baseUrl.pairingToken, {
		message: 'Paste a pairing link or enter an access token',
		path: ['token']
	});

export const environmentPatchSchema = z.object({
	name: nameSchema.optional(),
	baseUrl: environmentUrlSchema.optional(),
	token: tokenSchema.optional(),
	pairingToken: tokenSchema.optional(),
	enabled: z.boolean().optional()
});

/**
 * Resolves the base URL and access token to store. A pairing token (passed
 * explicitly or embedded in the pasted URL) is exchanged with the server for a
 * read-only access token; an explicit access token wins over pairing.
 */
export async function resolveEnvironmentConnection(input: {
	baseUrl: { baseUrl: string; pairingToken: string | null };
	token?: string;
	pairingToken?: string;
}): Promise<{ baseUrl: string; token: string | undefined }> {
	const baseUrl = input.baseUrl.baseUrl;
	if (input.token) return { baseUrl, token: input.token };
	const pairingToken = input.pairingToken ?? input.baseUrl.pairingToken;
	if (!pairingToken) return { baseUrl, token: undefined };
	return { baseUrl, token: await exchangePairingToken(baseUrl, pairingToken) };
}

/**
 * The id a T3 server reports for itself, or null when it can't be reached or
 * predates the field (then only the URL identifies it).
 */
export async function probeRemoteEnvironmentId(baseUrl: string): Promise<string | null> {
	try {
		return (await fetchEnvironmentDescriptor(baseUrl)).environmentId;
	} catch {
		return null;
	}
}

/** Fails with 409 when the user already connected this server (same URL or server id). */
export function rejectDuplicateEnvironment(
	db: Db,
	userId: string,
	target: { baseUrl: string; remoteEnvironmentId?: string | null },
	excludeId?: string
): void {
	const duplicate = findDuplicateCodingEnvironment(db, userId, target, excludeId);
	if (duplicate) {
		error(409, { message: `This T3 Code server is already connected as "${duplicate.name}"` });
	}
}
