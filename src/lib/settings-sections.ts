// The settings pages, as the settings nav and the command palette list them.

import type { Component } from 'svelte';
import BellIcon from '@lucide/svelte/icons/bell';
import BlocksIcon from '@lucide/svelte/icons/blocks';
import BoxesIcon from '@lucide/svelte/icons/boxes';
import BrainIcon from '@lucide/svelte/icons/brain';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import LockIcon from '@lucide/svelte/icons/lock';
import KeyboardIcon from '@lucide/svelte/icons/keyboard';
import Link2Icon from '@lucide/svelte/icons/link-2';
import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
import PlugIcon from '@lucide/svelte/icons/plug';
import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
import RouteIcon from '@lucide/svelte/icons/route';
import ServerIcon from '@lucide/svelte/icons/server';
import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
import UserRoundIcon from '@lucide/svelte/icons/user-round';
import UsersIcon from '@lucide/svelte/icons/users';

export const SETTINGS_GROUPS = ['You', 'Models', 'Integrations', 'Admin'] as const;

export interface SettingsSection {
	href: `/settings/${string}`;
	label: string;
	icon: Component;
	adminOnly: boolean;
	/** Shown to users who aren't admins only while private data is turned on. */
	privateDataOnly?: boolean;
	group: (typeof SETTINGS_GROUPS)[number];
}

export const SETTINGS_SECTIONS = [
	{
		href: '/settings/account',
		label: 'Account',
		icon: UserRoundIcon,
		adminOnly: false,
		group: 'You'
	},
	{
		href: '/settings/conversation',
		label: 'Conversation',
		icon: MessageCircleIcon,
		adminOnly: false,
		group: 'You'
	},
	{
		href: '/settings/notifications',
		label: 'Notifications',
		icon: BellIcon,
		adminOnly: false,
		group: 'You'
	},
	{
		href: '/settings/shortcuts',
		label: 'Keyboard shortcuts',
		icon: KeyboardIcon,
		adminOnly: false,
		group: 'You'
	},
	{ href: '/settings/memory', label: 'Memory', icon: BrainIcon, adminOnly: false, group: 'You' },
	{
		href: '/settings/private-data',
		label: 'Private data',
		icon: LockIcon,
		adminOnly: false,
		// Admins turn it on here; everyone else only needs it once it's on.
		privateDataOnly: true,
		group: 'You'
	},
	{
		href: '/settings/providers',
		label: 'Providers',
		icon: PlugIcon,
		adminOnly: true,
		group: 'Models'
	},
	{ href: '/settings/models', label: 'Models', icon: BoxesIcon, adminOnly: true, group: 'Models' },
	{
		href: '/settings/mappings',
		label: 'Mappings',
		icon: RouteIcon,
		adminOnly: true,
		group: 'Models'
	},
	{
		href: '/settings/defaults',
		label: 'Defaults',
		icon: SlidersHorizontalIcon,
		adminOnly: true,
		group: 'Models'
	},
	{
		href: '/settings/environments',
		label: 'Coding environments',
		icon: ServerIcon,
		adminOnly: false,
		group: 'Integrations'
	},
	{
		href: '/settings/connections',
		label: 'Connected apps',
		icon: Link2Icon,
		adminOnly: false,
		group: 'Integrations'
	},
	{
		href: '/settings/mcp',
		label: 'MCP servers',
		icon: BlocksIcon,
		// Everyone manages their personal servers; admins also the shared ones.
		adminOnly: false,
		group: 'Integrations'
	},
	{
		href: '/settings/services',
		label: 'Services',
		icon: PlugZapIcon,
		adminOnly: true,
		group: 'Integrations'
	},
	{
		href: '/settings/api',
		label: 'API',
		icon: KeyRoundIcon,
		adminOnly: false,
		group: 'Integrations'
	},
	{ href: '/settings/users', label: 'Users', icon: UsersIcon, adminOnly: true, group: 'Admin' }
] as const satisfies readonly SettingsSection[];

/** The sections a user may open. */
export function visibleSettingsSections(isAdmin: boolean, privateDataEnabled = false) {
	return SETTINGS_SECTIONS.filter(
		(section: SettingsSection) =>
			(!section.adminOnly || isAdmin) && (!section.privateDataOnly || isAdmin || privateDataEnabled)
	);
}
