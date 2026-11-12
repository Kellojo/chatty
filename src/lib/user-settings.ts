export const THEMES = ['light', 'dark', 'system'] as const;

export type Theme = (typeof THEMES)[number];

export const TIME_FORMATS = ['auto', '12h', '24h'] as const;

export type TimeFormat = (typeof TIME_FORMATS)[number];

export const DEFAULT_SUGGESTIONS = [
	'Explain a concept I keep forgetting',
	'Draft an email to my team',
	'Help me plan my week',
	'Brainstorm names for a project'
];

/** Quick starts for coding tasks; they fill the prompt rather than send it. */
export const DEFAULT_CODING_SUGGESTIONS = [
	'Explain the codebase',
	'Fix failing tests',
	'Find and fix a bug'
];

export const MAX_SUGGESTIONS = 8;

export const MAX_GLOBAL_INSTRUCTIONS_LENGTH = 2000;

/** Cap on starred models (encoded `providerId/modelId` refs). */
export const MAX_FAVORITE_MODELS = 50;

/**
 * Which events may alert the user. Kept per channel: `notificationTriggers` for
 * an open tab (title flash, pop-up, sound), `pushTriggers` for Web Push.
 */
export interface NotificationTriggers {
	/** A chat reply finished while you weren't looking at it. */
	replies: boolean;
	/** A coding task is waiting for your approval or answer. */
	needsYou: boolean;
	/** A coding task finished its run. */
	codingFinished: boolean;
	/** A coding task or agent run failed. */
	failures: boolean;
	/** A scheduled agent run finished successfully. */
	agentRuns: boolean;
}

export const NOTIFICATION_TRIGGER_KEYS = [
	'replies',
	'needsYou',
	'codingFinished',
	'failures',
	'agentRuns'
] as const satisfies readonly (keyof NotificationTriggers)[];

export const DEFAULT_NOTIFICATION_TRIGGERS: NotificationTriggers = {
	replies: true,
	needsYou: true,
	codingFinished: true,
	failures: true,
	agentRuns: false
};

export interface UserSettings {
	theme: Theme;
	suggestions: string[];
	codingSuggestions: string[];
	globalInstructions: string;
	timeFormat: TimeFormat;
	sidebarOpen: boolean;
	/** Starred models as encoded refs (`providerId/modelId`), in starring order. */
	favoriteModels: string[];
	/** Alerts an open Chatty tab raises. */
	notificationTriggers: NotificationTriggers;
	/** Pushes the server sends while Chatty is closed; until set, these follow `notificationTriggers`. */
	pushTriggers: NotificationTriggers;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
	theme: 'system',
	suggestions: DEFAULT_SUGGESTIONS,
	codingSuggestions: DEFAULT_CODING_SUGGESTIONS,
	globalInstructions: '',
	timeFormat: 'auto',
	sidebarOpen: true,
	favoriteModels: [],
	notificationTriggers: DEFAULT_NOTIFICATION_TRIGGERS,
	pushTriggers: DEFAULT_NOTIFICATION_TRIGGERS
};
