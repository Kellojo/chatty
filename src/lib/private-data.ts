import { decodeModelRef, isMappingProviderId, mappingIdFromProviderId } from './model-ref.js';
import type { ModelMapping, PrivateDataStatus } from './types.js';

/**
 * Starts the error of a tool call the private-data guard refused. Mirrors
 * `BLOCKED_PREFIX` in `$lib/server/privacy/guard.ts` (server code can't be
 * imported here); keep the two in sync.
 */
export const PRIVATE_BLOCKED_PREFIX = 'Blocked: this chat contains private data';

/** What the app shell knows when the private-data feature is off (or not loaded). */
export const PRIVATE_DATA_OFF: PrivateDataStatus = {
	enabled: false,
	available: false,
	sttTrusted: false,
	ttsTrusted: false
};

/** Why a private chat refused a tool, from its error text; null when it wasn't refused for that. */
export function blockedToolReason(text: string | null | undefined): 'egress' | 'persist' | null {
	if (!text?.includes(PRIVATE_BLOCKED_PREFIX)) return null;
	return text.includes('stores data where it would not stay private') ? 'persist' : 'egress';
}

/** The friendly line a tool card shows for a call refused in a private chat. */
export function blockedToolLabel(reason: 'egress' | 'persist'): string {
	return reason === 'persist'
		? "Blocked in private chats: this tool stores data where it wouldn't stay private"
		: 'Blocked in private chats: this tool sends data outside Chatty';
}

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
export const PRIVATE_CHAT_HINT =
	'Private chat: only trusted models, and no tools that send data outside Chatty.';
