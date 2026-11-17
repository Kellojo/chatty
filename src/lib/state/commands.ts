// Commands the command palette (Mod+K) offers on top of its own navigation and
// search. Views that own an action register it while they're mounted: the app
// shell its global actions, the open chat its conversation actions, …
//
// Sources are read when the palette opens, so labels can follow current state
// (Pin / Unpin) without the registry being reactive.

import type { Component } from 'svelte';
import type { COMBOS } from './shortcuts.js';

/** Palette sections, in the order they're shown. */
export const COMMAND_GROUPS = ['This chat', 'Actions'] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface PaletteCommand {
	/** Unique within the palette; also what a selection reports. */
	id: string;
	label: string;
	group: CommandGroup;
	icon?: Component;
	/** Muted text after the label: where it leads, or a detail such as a time. */
	hint?: string;
	/** Extra words it should be found by. */
	keywords?: string[];
	/** The keyboard shortcut that does the same, shown beside it. */
	shortcut?: keyof typeof COMBOS;
	destructive?: boolean;
	/** Left out of the opening list, to keep it short; found once you type. */
	searchOnly?: boolean;
	/** Runs once the palette has closed and handed focus back. */
	run(): unknown;
}

type CommandSource = () => PaletteCommand[];

const sources: CommandSource[] = [];

/** Adds commands while a view is mounted; returns the unregister function. */
export function registerCommands(source: CommandSource): () => void {
	sources.push(source);
	return () => {
		const index = sources.lastIndexOf(source);
		if (index !== -1) sources.splice(index, 1);
	};
}

/** Every registered command right now, grouped in display order. */
export function registeredCommands(): { group: CommandGroup; commands: PaletteCommand[] }[] {
	const all = sources.flatMap((source) => source());
	return COMMAND_GROUPS.map((group) => ({
		group,
		commands: all.filter((command) => command.group === group)
	})).filter((entry) => entry.commands.length > 0);
}
