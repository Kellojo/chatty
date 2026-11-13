import type { Component } from 'svelte';
import BotIcon from '@lucide/svelte/icons/bot';
import BrainIcon from '@lucide/svelte/icons/brain';
import CalculatorIcon from '@lucide/svelte/icons/calculator';
import ClockIcon from '@lucide/svelte/icons/clock';
import CloudSunIcon from '@lucide/svelte/icons/cloud-sun';
import FolderIcon from '@lucide/svelte/icons/folder';
import GlobeIcon from '@lucide/svelte/icons/globe';
import HourglassIcon from '@lucide/svelte/icons/hourglass';
import ImageIcon from '@lucide/svelte/icons/image';
import MessageSquareTextIcon from '@lucide/svelte/icons/message-square-text';
import SettingsIcon from '@lucide/svelte/icons/settings';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import TerminalIcon from '@lucide/svelte/icons/terminal';

/** One-line purpose for each bundled MCP server, shown under its name. */
export const BUILTIN_PURPOSE: Record<string, string> = {
	webfetch: 'Fetch and read web pages',
	datetime: 'Current date, time and time zones',
	'chat-search': 'Search your past conversations',
	fs: 'Read and write files in the agent workspace',
	settings: "Read and change Chatty's settings",
	memory: 'Read and save long-term memory',
	agents: 'Create, run and manage agents',
	skills: 'Load skills and their reference files',
	'code-exec': 'Run code in a sandbox',
	image: 'Generate and edit images',
	wait: 'Pause, then check back on long tasks',
	math: 'Evaluate math expressions',
	weather: 'Current weather and forecasts'
};

/** Icon for each bundled MCP server (others use a generic one). */
export const BUILTIN_ICON: Record<string, Component<{ class?: string }>> = {
	webfetch: GlobeIcon,
	datetime: ClockIcon,
	'chat-search': MessageSquareTextIcon,
	fs: FolderIcon,
	settings: SettingsIcon,
	memory: BrainIcon,
	agents: BotIcon,
	skills: SparklesIcon,
	'code-exec': TerminalIcon,
	image: ImageIcon,
	wait: HourglassIcon,
	math: CalculatorIcon,
	weather: CloudSunIcon
};
