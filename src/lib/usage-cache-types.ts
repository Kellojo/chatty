// Prompt-cache token counts on top of the pay-as-you-go usage shapes in
// `$lib/components/app/usage/usage.ts`. Every count is part of the matching
// input tokens (input includes cache reads and writes), not in addition to them.

import type { PaygProvider, PaygUsage } from '$lib/components/app/usage/usage.js';

export interface CacheTokenCounts {
	/** Input tokens read from the provider's prompt cache. */
	cacheReadTokens: number;
	/** Input tokens written to the provider's prompt cache. */
	cacheWriteTokens: number;
}

export type PaygModelWithCache = PaygProvider['models'][number] & CacheTokenCounts;

export interface PaygProviderWithCache extends PaygProvider, CacheTokenCounts {
	models: PaygModelWithCache[];
}

export interface PaygUsageWithCache extends PaygUsage {
	providers: PaygProviderWithCache[];
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
}
