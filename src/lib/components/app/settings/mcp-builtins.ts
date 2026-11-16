import type { Component } from 'svelte';
import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
import BotIcon from '@lucide/svelte/icons/bot';
import BrainIcon from '@lucide/svelte/icons/brain';
import BotMessageSquareIcon from '@lucide/svelte/icons/bot-message-square';
import CalculatorIcon from '@lucide/svelte/icons/calculator';
import ClockIcon from '@lucide/svelte/icons/clock';
import CloudSunIcon from '@lucide/svelte/icons/cloud-sun';
import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
import FolderIcon from '@lucide/svelte/icons/folder';
import GlobeIcon from '@lucide/svelte/icons/globe';
import ImageIcon from '@lucide/svelte/icons/image';
import MessageSquareTextIcon from '@lucide/svelte/icons/message-square-text';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import TerminalIcon from '@lucide/svelte/icons/terminal';

/** One-line purpose for each bundled MCP server, shown under its name. */
export const BUILTIN_PURPOSE: Record<string, string> = {
	webfetch: 'Fetch and read web pages',
	datetime: 'Current time, time zones and waiting',
	'chat-search': 'Search your past conversations',
	fs: 'Read and write files in the agent workspace',
	memory: 'Read and save long-term memory',
	agents: 'Create, run and manage agents',
	subagents: 'Hand self-contained work to a subagent',
	coding: 'Propose coding tasks for your coding environments',
	skills: 'Load skills and their reference files',
	'code-exec': 'Run code in a sandbox',
	image: 'Generate and edit images',
	speech: 'Transcribe uploaded audio files',
	math: 'Exact arithmetic, statistics and unit conversion',
	weather: 'Current weather and forecasts'
};

/** Icon for each bundled MCP server (others use a generic one). */
export const BUILTIN_ICON: Record<string, Component<{ class?: string }>> = {
	webfetch: GlobeIcon,
	datetime: ClockIcon,
	'chat-search': MessageSquareTextIcon,
	fs: FolderIcon,
	memory: BrainIcon,
	agents: BotIcon,
	subagents: BotMessageSquareIcon,
	coding: CodeXmlIcon,
	skills: SparklesIcon,
	'code-exec': TerminalIcon,
	image: ImageIcon,
	speech: AudioLinesIcon,
	math: CalculatorIcon,
	weather: CloudSunIcon
};
