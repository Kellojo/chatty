import { APICallError, RetryError } from 'ai';
import { isMappingProviderId, mappingIdFromProviderId, type ModelRef } from '$lib/model-ref.js';
import type { ModelMappingTarget } from '$lib/types.js';
import { getDb, type Db } from '../db/index.js';
import { getModelMapping, parseTargets } from '../db/repo/model-mappings.js';
import { findModel } from '../db/repo/models.js';

export class ModelUnavailableError extends Error {}

export interface ResolvedRef {
	mappingId: string | null;
	targets: ModelMappingTarget[];
}

export function resolveRefTargets(ref: ModelRef, db: Db = getDb()): ResolvedRef {
	if (!ref.providerId.startsWith('mapping:')) {
		return { mappingId: null, targets: [{ providerId: ref.providerId, modelId: ref.modelId }] };
	}
	const mapping = getModelMapping(db, mappingIdFromProviderId(ref.providerId));
	if (!mapping || mapping.enabled !== 1) {
		throw new ModelUnavailableError(`Model mapping "${ref.modelId}" is not available`);
	}
	const targets = parseTargets(mapping);
	if (targets.length === 0) {
		throw new ModelUnavailableError(`Model mapping "${ref.modelId}" has no targets`);
	}
	return { mappingId: mapping.id, targets };
}

export function isSelectableModelRef(ref: ModelRef, db: Db = getDb()): boolean {
	if (isMappingProviderId(ref.providerId)) {
		const mapping = getModelMapping(db, mappingIdFromProviderId(ref.providerId));
		return mapping !== undefined && mapping.enabled === 1;
	}
	return findModel(db, ref.providerId, ref.modelId) !== undefined;
}

/** Whether a failed model call should move on to the next target (a mapping's fallback). */
export function isRetryableModelError(error: unknown): boolean {
	// The SDK's own retries wrap the last attempt's error.
	if (RetryError.isInstance(error)) return isRetryableModelError(error.lastError);
	if (error instanceof ModelUnavailableError) return true;
	if (error instanceof TypeError) return true;
	// Connection failures (e.g. ECONNREFUSED) have no status code but are flagged retryable.
	if (APICallError.isInstance(error) && error.isRetryable) return true;
	const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
	return (
		typeof statusCode === 'number' &&
		(statusCode === 408 ||
			statusCode === 409 ||
			statusCode === 425 ||
			statusCode === 429 ||
			statusCode >= 500)
	);
}
