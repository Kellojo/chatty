<script lang="ts" module>
	import type { Agent } from '$lib/types.js';
	import type { SkillSummary } from '$lib/skill-types.js';

	// Agents and skills from the last time the palette opened, so they're there
	// at once next time while a fresh copy loads.
	let agentCache: Agent[] = [];
	let skillCache: SkillSummary[] = [];
</script>

<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { Command, computeCommandScore } from 'bits-ui';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { toast } from 'svelte-sonner';
	import { signOutToLogin } from '$lib/auth-client.js';
	import { registeredCommands, type PaletteCommand } from '$lib/state/commands.js';
	import { COMBOS } from '$lib/state/shortcuts.js';
	import { visibleSettingsSections } from '$lib/settings-sections.js';
	import { skillPath } from '$lib/skill-labels.js';
	import { THEMES, type Theme } from '$lib/user-settings.js';
	import type { Conversation } from '$lib/types.js';
	import ShortcutKeys from './ShortcutKeys.svelte';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import BotIcon from '@lucide/svelte/icons/bot';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CreditCardIcon from '@lucide/svelte/icons/credit-card';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import LockIcon from '@lucide/svelte/icons/lock';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import SunIcon from '@lucide/svelte/icons/sun';
	import ZapIcon from '@lucide/svelte/icons/zap';

	let {
		isAdmin,
		onopenchat,
		onchoose
	}: {
		isAdmin: boolean;
		onopenchat: (id: string) => void;
		/** Closes the palette and then runs the chosen command. */
		onchoose: (run: () => unknown) => void;
	} = $props();

	/** A palette row: a registered command, or one of the palette's own. */
	type Entry = Omit<PaletteCommand, 'group'> & {
		/** Marks the current choice (the active theme). */
		checked?: boolean;
	};

	interface Section {
		heading: string;
		entries: Entry[];
	}

	let query = $state('');
	const searching = $derived(query.trim().length > 0);

	// ── read once per opening ────────────────────────────────────────────────
	const registeredGroups = registeredCommands();
	const registered = $derived<Section[]>(
		registeredGroups.map(({ group, commands }) => ({
			heading: group,
			entries: searching ? commands : commands.filter((command) => !command.searchOnly)
		}))
	);
	const currentChatId = page.params.id;
	const knownChats = ((page.data.conversations as Conversation[] | undefined) ?? []).filter(
		(c) => c.id !== currentChatId
	);

	const pages: Entry[] = [
		{ id: 'go:/agents', label: 'Agents', icon: BotIcon, run: () => goto(resolve('/agents')) },
		{
			id: 'go:/agents/new',
			label: 'New agent',
			icon: PlusIcon,
			keywords: ['create agent'],
			run: () => goto(resolve('/agents/new'))
		},
		{ id: 'go:/memory', label: 'Memory', icon: BrainIcon, run: () => goto(resolve('/memory')) },
		{ id: 'go:/skills', label: 'Skills', icon: SparklesIcon, run: () => goto(resolve('/skills')) },
		{
			id: 'go:/skills/new',
			label: 'New skill',
			icon: PlusIcon,
			keywords: ['create skill'],
			run: () => goto(resolve('/skills/new'))
		},
		{
			id: 'go:/usage',
			label: 'Usage',
			icon: GaugeIcon,
			keywords: ['tokens', 'cost'],
			run: () => goto(resolve('/usage'))
		},
		{
			id: 'go:/usage/requests',
			label: 'Requests',
			hint: 'Usage',
			icon: ActivityIcon,
			keywords: ['usage', 'logs'],
			run: () => goto(resolve('/usage/requests'))
		},
		{
			id: 'go:/usage/subscriptions',
			label: 'Subscriptions',
			hint: 'Usage',
			icon: CreditCardIcon,
			keywords: ['usage', 'plan', 'limits'],
			run: () => goto(resolve('/usage/subscriptions'))
		},
		{
			id: 'go:/usage/speed',
			label: 'Speed',
			hint: 'Usage',
			icon: ZapIcon,
			keywords: ['usage', 'tokens per second'],
			run: () => goto(resolve('/usage/speed'))
		},
		{
			id: 'go:/settings',
			label: 'Settings',
			icon: SettingsIcon,
			run: () => goto(resolve('/settings'))
		}
	];

	const settings = $derived<Entry[]>(
		visibleSettingsSections(
			isAdmin,
			(page.data.privateData as { enabled?: boolean } | undefined)?.enabled ?? false
		).map((section) => ({
			id: `go:${section.href}`,
			label: section.label,
			hint: 'Settings',
			icon: section.icon,
			keywords: ['settings', section.group],
			run: () => goto(resolve(section.href))
		}))
	);

	const THEME_ICONS: Record<Theme, Component> = {
		light: SunIcon,
		dark: MoonIcon,
		system: MonitorIcon
	};
	const THEME_LABELS: Record<Theme, string> = {
		light: 'Light theme',
		dark: 'Dark theme',
		system: 'System theme'
	};

	async function chooseTheme(theme: Theme) {
		const previous = userPrefersMode.current;
		setMode(theme);
		const res = await fetch('/api/user/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ theme })
		}).catch(() => null);
		if (!res?.ok) {
			setMode(previous);
			toast.error('Failed to update theme');
		}
	}

	const preferences: Entry[] = [
		...THEMES.map((theme) => ({
			id: `theme:${theme}`,
			label: THEME_LABELS[theme],
			icon: THEME_ICONS[theme],
			keywords: ['appearance', 'mode', 'color scheme'],
			checked: userPrefersMode.current === theme,
			run: () => chooseTheme(theme)
		})),
		{
			id: 'sign-out',
			label: 'Sign out',
			icon: LogOutIcon,
			keywords: ['log out', 'logout'],
			run: () => void signOutToLogin()
		}
	];

	// ── conversations ────────────────────────────────────────────────────────
	/** Id prefix of server search matches, which the filter keeps. */
	const FOUND = 'found';

	function chatEntry(c: Conversation, prefix: string): Entry {
		return {
			id: `${prefix}:${c.id}`,
			label: c.title || (c.coding ? 'New task' : 'New chat'),
			icon: c.private ? LockIcon : c.coding ? SquareTerminalIcon : MessageSquareIcon,
			hint: c.pinned ? 'Pinned' : undefined,
			run: () => onopenchat(c.id)
		};
	}

	/** Server matches (titles and message text) for the query, newest request wins. */
	let found = $state.raw<Conversation[]>([]);
	let loadingFound = $state(false);
	$effect(() => {
		const q = query.trim();
		if (q.length < 2) {
			found = [];
			loadingFound = false;
			return;
		}
		const controller = new AbortController();
		loadingFound = true;
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(q)}`, {
					signal: controller.signal
				});
				if (!res.ok) return;
				const data = (await res.json()) as { conversations: Conversation[] };
				found = data.conversations.filter((c) => c.id !== currentChatId);
			} catch {
				// Aborted by a newer query, or offline: keep what's shown.
			} finally {
				if (!controller.signal.aborted) loadingFound = false;
			}
		}, 150);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	const chats = $derived.by((): Entry[] => {
		if (!searching) return knownChats.slice(0, 5).map((c) => chatEntry(c, 'chat'));
		// Server matches show as they come (they may match on message text);
		// the loaded chats fill in, filtered by title.
		const foundIds = new Set(found.map((c) => c.id));
		return [
			...found.map((c) => chatEntry(c, FOUND)),
			...knownChats.filter((c) => !foundIds.has(c.id)).map((c) => chatEntry(c, 'chat'))
		];
	});

	// ── agents and skills (only while searching, to keep the start short) ─────
	let agents = $state.raw(agentCache);
	let skills = $state.raw(skillCache);

	onMount(() => {
		const controller = new AbortController();
		const load = async <T,>(url: string, pick: (body: unknown) => T, set: (v: T) => void) => {
			try {
				const res = await fetch(url, { signal: controller.signal });
				if (res.ok) set(pick(await res.json()));
			} catch {
				// Keep the cached list.
			}
		};
		void load(
			'/api/agents',
			(body) => (body as { agents: Agent[] }).agents,
			(v) => (agents = agentCache = v)
		);
		void load(
			'/api/skills',
			(body) => (body as { skills: SkillSummary[] }).skills,
			(v) => (skills = skillCache = v)
		);
		return () => controller.abort();
	});

	const agentEntries = $derived(
		agents.map((agent): Entry => ({
			id: `agent:${agent.id}`,
			label: agent.name,
			hint: 'Agent',
			icon: BotIcon,
			keywords: ['agent', agent.description],
			run: () => goto(resolve(`/agents/${agent.id}`))
		}))
	);

	const skillEntries = $derived(
		skills.map((skill): Entry => ({
			id: `skill:${skill.scope}:${skill.name}`,
			label: skill.title,
			hint: skill.enabled ? 'Skill' : 'Skill · off',
			icon: SparklesIcon,
			keywords: ['skill', skill.name, skill.description],
			run: () => goto(resolve(skillPath(skill)))
		}))
	);

	const sections = $derived<Section[]>(
		[
			...registered,
			{ heading: searching ? 'Conversations' : 'Recent conversations', entries: chats },
			{ heading: 'Go to', entries: pages },
			...(searching
				? [
						{ heading: 'Settings', entries: settings },
						{ heading: 'Agents', entries: agentEntries },
						{ heading: 'Skills', entries: skillEntries }
					]
				: []),
			{ heading: 'Preferences', entries: preferences }
		].filter((section) => section.entries.length > 0)
	);

	// Server matches are already a search result: they always stay. Everything
	// else is ranked by its label and keywords.
	function filter(value: string, search: string, keywords?: string[]): number {
		if (value.startsWith(`${FOUND}:`)) return 1;
		return computeCommandScore('', search, keywords);
	}
</script>

<Command.Root
	{filter}
	loop
	vimBindings={false}
	class="flex min-h-0 flex-col"
	label="Command palette"
>
	<div class="flex items-center gap-2.5 border-b px-4">
		<SearchIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<Command.Input
			bind:value={query}
			placeholder="Search or jump to…"
			class="h-13 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
		/>
	</div>
	<Command.List
		class="max-h-[min(28rem,calc(100dvh-12rem))] scroll-py-2 overflow-y-auto overscroll-contain"
	>
		<Command.Viewport class="p-2">
			<Command.Empty class="px-3 py-8 text-center text-sm text-muted-foreground">
				{loadingFound ? 'Searching…' : 'No results'}
			</Command.Empty>
			{#each sections as section (section.heading)}
				<Command.Group value={section.heading} class="not-first:mt-2">
					<Command.GroupHeading class="px-3 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
						{section.heading}
					</Command.GroupHeading>
					<Command.GroupItems>
						{#each section.entries as entry (entry.id)}
							<Command.Item
								value={entry.id}
								keywords={[entry.label, ...(entry.keywords ?? [])]}
								onSelect={() => onchoose(entry.run)}
								class="group flex cursor-default items-center gap-2.5 rounded-2xl px-3 py-2 text-sm outline-none select-none data-selected:bg-accent data-selected:text-accent-foreground {entry.destructive
									? 'text-destructive data-selected:bg-destructive/10 data-selected:text-destructive'
									: ''}"
							>
								{#if entry.icon}
									<entry.icon
										class="size-4 shrink-0 {entry.destructive
											? 'text-destructive'
											: 'text-muted-foreground group-data-selected:text-accent-foreground'}"
										aria-hidden="true"
									/>
								{/if}
								<span class="min-w-0 truncate">{entry.label}</span>
								{#if entry.hint}
									<span class="shrink-0 text-xs text-muted-foreground">{entry.hint}</span>
								{/if}
								{#if entry.checked}
									<CheckIcon class="size-4 shrink-0" aria-label="Current" />
								{/if}
								{#if entry.shortcut}
									<span class="ml-auto pl-2 max-sm:hidden">
										<ShortcutKeys entry={{ combos: [COMBOS[entry.shortcut]] }} />
									</span>
								{/if}
							</Command.Item>
						{/each}
					</Command.GroupItems>
				</Command.Group>
			{/each}
		</Command.Viewport>
	</Command.List>
	<div
		class="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground pointer-coarse:hidden"
		aria-hidden="true"
	>
		<span class="flex items-center gap-1.5"
			><ShortcutKeys entry={{ combos: ['↑', '↓'], separator: '/' }} /> Move</span
		>
		<span class="flex items-center gap-1.5"><ShortcutKeys entry={{ combos: ['↵'] }} /> Open</span>
		<span class="flex items-center gap-1.5"><ShortcutKeys entry={{ combos: ['Esc'] }} /> Close</span
		>
		<span class="ml-auto flex items-center gap-1.5"
			><ShortcutKeys entry={{ combos: [COMBOS['command-palette']] }} /> Toggle</span
		>
	</div>
</Command.Root>
