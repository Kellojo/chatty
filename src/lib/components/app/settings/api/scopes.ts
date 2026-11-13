import type { Component } from 'svelte';
import BrainCircuitIcon from '@lucide/svelte/icons/brain-circuit';
import WaypointsIcon from '@lucide/svelte/icons/waypoints';
import WebhookIcon from '@lucide/svelte/icons/webhook';

/** The API key scopes, in the order the UI lists them (most used first). */
export const API_SCOPES = ['llm:invoke', 'mcp:use', 'agents:run'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** How the UI names each scope: the task it unlocks. */
export const SCOPE_INFO: Record<
	ApiScope,
	{ title: string; description: string; icon: Component<{ class?: string }> }
> = {
	'llm:invoke': {
		title: 'Model inference',
		description: 'Call your models through the OpenAI-compatible API.',
		icon: BrainCircuitIcon
	},
	'mcp:use': {
		title: 'MCP gateway',
		description: "Use Chatty's tools from Claude Code, Codex and other MCP clients.",
		icon: WaypointsIcon
	},
	'agents:run': {
		title: 'Agent webhooks',
		description: 'Start agent runs from cron, CI or other apps.',
		icon: WebhookIcon
	}
};
