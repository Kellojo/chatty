<script lang="ts">
	import type { Component } from 'svelte';
	import type { ToolKind } from '$lib/tool-meta.js';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import CodeIcon from '@lucide/svelte/icons/code';
	import FilePenIcon from '@lucide/svelte/icons/file-pen';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import BotIcon from '@lucide/svelte/icons/bot';
	import BookmarkIcon from '@lucide/svelte/icons/bookmark';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import ImageIcon from '@lucide/svelte/icons/image';
	import CalculatorIcon from '@lucide/svelte/icons/calculator';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import CloudSunIcon from '@lucide/svelte/icons/cloud-sun';
	import HourglassIcon from '@lucide/svelte/icons/hourglass';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import FlagIcon from '@lucide/svelte/icons/flag';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-question-mark';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WrenchIcon from '@lucide/svelte/icons/wrench';

	let { kind, class: className }: { kind: ToolKind; class?: string } = $props();

	const ICONS: Record<ToolKind, Component<{ class?: string }>> = {
		command: TerminalIcon,
		code: CodeIcon,
		edit: FilePenIcon,
		read: FileTextIcon,
		search: SearchIcon,
		web: GlobeIcon,
		agent: BotIcon,
		subagent: BotIcon,
		memory: BookmarkIcon,
		skill: SparklesIcon,
		image: ImageIcon,
		math: CalculatorIcon,
		time: ClockIcon,
		settings: SettingsIcon,
		weather: CloudSunIcon,
		wait: HourglassIcon,
		chat: MessagesSquareIcon,
		checkpoint: FlagIcon,
		todo: ListChecksIcon,
		question: CircleHelpIcon,
		approval: ShieldCheckIcon,
		error: TriangleAlertIcon,
		tool: WrenchIcon
	};

	const Icon = $derived(ICONS[kind]);
</script>

<Icon class={className} />
