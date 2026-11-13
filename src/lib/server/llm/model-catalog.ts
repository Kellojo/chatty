import { createHash } from 'node:crypto';
import type { ModelCatalogInfo, PickerModelGroup } from '$lib/types.js';
import { listModelsGrouped } from './registry.js';

export interface ModelCatalog {
	version: string;
	groups: PickerModelGroup[];
}

/**
 * The enabled models, trimmed to what the model pickers show. With hundreds of
 * models this is the bulk of a chat page's data, so pages send only its
 * `version` on client-side loads and the client fetches the list itself from
 * /api/models/catalog when that changes (see `$lib/state/model-catalog`).
 */
export function getModelCatalog(): ModelCatalog {
	const groups: PickerModelGroup[] = listModelsGrouped().map(({ provider, models }) => ({
		provider: {
			id: provider.id,
			name: provider.name,
			type: provider.type,
			baseUrl: provider.baseUrl
		},
		models: models.map((m) => ({
			providerId: m.providerId,
			modelId: m.modelId,
			displayName: m.displayName,
			capabilities: m.capabilities
		}))
	}));
	const version = createHash('sha256')
		.update(JSON.stringify(groups))
		.digest('base64url')
		.slice(0, 16);
	return { version, groups };
}

/**
 * The catalog as a page load reports it: the whole list only on a full page
 * load (`isDataRequest` false), which seeds the client; client-side loads and
 * invalidations get just the version, so they no longer re-send every model.
 */
export function modelCatalogInfo(isDataRequest: boolean): ModelCatalogInfo {
	const { version, groups } = getModelCatalog();
	const count = groups.reduce((n, g) => n + g.models.length, 0);
	return isDataRequest ? { version, count } : { version, count, groups };
}
