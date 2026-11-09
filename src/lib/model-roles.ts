import type { ModelRole } from '$lib/types.js';

/** User-facing names of the purposes picked in Settings → Defaults. */
export const MODEL_ROLE_LABEL: Record<ModelRole, string> = {
	chat: 'Default chat model',
	title: 'Title generation',
	memory: 'Memory',
	image: 'Image generation',
	compaction: 'Chat compaction',
	'speech-to-text': 'Speech to text',
	decisions: 'Decisions'
};
