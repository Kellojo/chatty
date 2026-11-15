import type { RequestPurpose } from '$lib/types.js';

/** How the requests log names what a call was for; plain completions get no label. */
export const REQUEST_PURPOSE_LABEL: Record<Exclude<RequestPurpose, 'completion'>, string> = {
	title: 'Title',
	compaction: 'Compaction',
	transcription: 'Speech to text',
	speech: 'Text to speech',
	image: 'Image'
};

export function requestPurposeLabel(purpose: RequestPurpose): string | null {
	return purpose === 'completion' ? null : REQUEST_PURPOSE_LABEL[purpose];
}
