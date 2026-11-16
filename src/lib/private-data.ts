import { decodeModelRef, isMappingProviderId, mappingIdFromProviderId } from './model-ref.js';
import type { ModelMapping, PrivateDataStatus } from './types.js';

/** What the app shell knows when the private-data feature is off (or not loaded). */
export const PRIVATE_DATA_OFF: PrivateDataStatus = {
	enabled: false,
	available: false,
	sttTrusted: false,
	ttsTrusted: false
};

/** A provider as the pickers see it; `allowPrivate` marks one trusted with private data. */
type TrustProvider = { id: string; allowPrivate?: boolean };

/** The providers trusted with private data, among the pickers' groups. */
export function trustedProviderIds(groups: readonly { provider: TrustProvider }[]): Set<string> {
	return new Set(groups.filter((g) => g.provider.allowPrivate === true).map((g) => g.provider.id));
}

/** A mapping may run a private chat only when every target is on a trusted provider. */
export function mappingTrusted(
	mapping: Pick<ModelMapping, 'targets'>,
	trusted: ReadonlySet<string>
): boolean {
	return mapping.targets.length > 0 && mapping.targets.every((t) => trusted.has(t.providerId));
}

/**
 * Whether a picker value (`providerId/modelId`, or a mapping's ref) may run a
 * private chat. Unknown providers and mappings count as untrusted.
 */
export function modelValueTrusted(
	value: string,
	trusted: ReadonlySet<string>,
	mappings: readonly ModelMapping[]
): boolean {
	if (!value) return false;
	const { providerId } = decodeModelRef(value);
	if (isMappingProviderId(providerId)) {
		const id = mappingIdFromProviderId(providerId);
		const mapping = mappings.find((m) => m.id === id);
		return mapping ? mappingTrusted(mapping, trusted) : false;
	}
	return trusted.has(providerId);
}

/** The one-line reminder under the composer of a private chat (new and existing). */
export const PRIVATE_CHAT_HINT = 'Private chat: only models trusted with private data see it.';

/**
 * A part the server writes into a reply at the moment a tool handed the turn
 * private data and the chat became private, so the chat shows it in place.
 * Data parts never reach the model.
 */
export const PRIVACY_NOTICE_PART = 'data-privacy-notice';

export interface PrivacyNotice {
	/** What the turn read, as a short noun phrase: "a private note", "a private chat". */
	reason: string;
}

export function readPrivacyNotice(part: { type: string }): PrivacyNotice | null {
	if (part.type !== PRIVACY_NOTICE_PART) return null;
	const reason = (part as { data?: { reason?: unknown } }).data?.reason;
	return { reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'private data' };
}
