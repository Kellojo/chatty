import HandIcon from '@lucide/svelte/icons/hand';
import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
import ZapIcon from '@lucide/svelte/icons/zap';
import type { CodingAutonomy } from '$lib/coding-environments.js';

/** One icon per permission level, shared by the composer and the task details. */
export const AUTONOMY_ICONS: Record<CodingAutonomy, typeof HandIcon> = {
	supervised: HandIcon,
	'auto-edits': PencilLineIcon,
	auto: ZapIcon,
	'full-access': ShieldAlertIcon
};

/** Full access is the one level worth a warning tone. */
export const FULL_ACCESS_TONE = 'text-amber-600 dark:text-amber-400';
