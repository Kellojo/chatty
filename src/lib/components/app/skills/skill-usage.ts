import type { SkillTrigger } from '$lib/skill-types.js';

/** How each trigger reads in usage views, and its color in charts. */
export const TRIGGER_INFO: Record<
	SkillTrigger,
	{ label: string; short: string; description: string; color: string }
> = {
	manual: {
		label: 'Picked by hand',
		short: 'Picked',
		description: 'Chosen in the message composer',
		color: 'var(--chart-1)'
	},
	auto: {
		label: 'Loaded by the model',
		short: 'Auto',
		description: 'The model loaded it because the request matched',
		color: 'var(--chart-2)'
	},
	agent: {
		label: 'Agent runs',
		short: 'Agents',
		description: 'Loaded during an agent run',
		color: 'var(--chart-4)'
	}
};

export const plural = (n: number, word: string) =>
	`${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** Share as a whole percent; any nonzero part shows as at least 1%. */
export const percent = (part: number, whole: number) =>
	whole === 0 || part === 0 ? '0%' : `${Math.max(1, Math.round((part / whole) * 100))}%`;
