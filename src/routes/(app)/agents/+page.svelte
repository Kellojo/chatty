<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import BotIcon from '@lucide/svelte/icons/bot';
	import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import RowMenu, { type RowMenuItem } from '$lib/components/app/settings/RowMenu.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import { EVENT_LABELS, ordinal, TRIGGER_LABELS } from '$lib/agent-labels.js';
	import { describeCron } from '$lib/cron.js';
	import { formatDateTime, formatTimeAgo } from '$lib/datetime.js';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import type { Agent } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let runBusy = $state<string | null>(null);
	let toggleBusy = $state<string | null>(null);
	let deleteTarget = $state<Agent | null>(null);
	let deleteBusy = $state(false);

	$effect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const schedule = () => {
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				void invalidateAll();
			}, 300);
		};
		const off = onServerEvent((event) => {
			if (event.type === 'agent.run.started' || event.type === 'agent.run.finished') schedule();
		});
		return () => {
			off();
			if (timer) clearTimeout(timer);
		};
	});

	const sections = $derived([
		{
			title: 'Your agents',
			description: undefined,
			agents: data.agents.filter((agent) => agent.userId !== null)
		},
		{
			title: 'Built-in',
			description: 'Ship with Chatty. Turn them on or off and run them; their setup is fixed.',
			agents: data.agents.filter((agent) => agent.userId === null)
		}
	]);

	function menuItems(agent: Agent, running: boolean): RowMenuItem[] {
		const builtin = agent.userId === null;
		const items: RowMenuItem[] = [
			{
				label: running ? 'Running…' : 'Run now',
				icon: PlayIcon,
				disabled: runBusy !== null || running,
				onSelect: () => runNow(agent)
			},
			{
				label: 'Run history',
				icon: HistoryIcon,
				onSelect: () => goto(resolve(`/agents/${agent.id}/runs`))
			},
			{
				label: builtin ? 'View setup' : 'Edit',
				icon: builtin ? EyeIcon : PencilIcon,
				onSelect: () => goto(resolve(`/agents/${agent.id}`))
			}
		];
		if (!builtin) {
			items.push('separator', {
				label: 'Delete',
				icon: Trash2Icon,
				destructive: true,
				onSelect: () => (deleteTarget = agent)
			});
		}
		return items;
	}

	async function runNow(agent: Agent) {
		if (runBusy) return;
		runBusy = agent.id;
		try {
			const res = await fetch(`/api/agents/${agent.id}/run`, { method: 'POST' });
			const body = (await res.json().catch(() => null)) as {
				ignored?: boolean;
				message?: string;
			} | null;
			if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
			if (body?.ignored) toast(body.message ?? 'Run ignored');
			else toast.success('Run started');
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to start run');
		} finally {
			runBusy = null;
		}
	}

	async function toggleAgent(agent: Agent, checked: boolean) {
		if (toggleBusy) return;
		toggleBusy = agent.id;
		try {
			const res = await fetch(`/api/agents/${agent.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled: checked })
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? `Request failed (${res.status})`);
			}
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update agent');
		} finally {
			toggleBusy = null;
		}
	}

	async function confirmDelete() {
		if (!deleteTarget || deleteBusy) return;
		deleteBusy = true;
		try {
			const res = await fetch(`/api/agents/${deleteTarget.id}`, { method: 'DELETE' });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? `Request failed (${res.status})`);
			}
			toast.success('Agent deleted');
			deleteTarget = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete agent');
		} finally {
			deleteBusy = false;
		}
	}
</script>

<svelte:head><title>Agents · Chatty</title></svelte:head>

{#snippet triggerLabel(agent: Agent)}
	{#if agent.triggerType === 'schedule'}
		{describeCron(agent.triggerConfig.cron, data.timeFormat) ?? 'Schedule'}
	{:else if agent.triggerType === 'event'}
		{@const every = agent.triggerConfig.every ?? 1}
		{@const event = agent.triggerConfig.event}
		{@const label = event ? EVENT_LABELS[event].toLowerCase() : 'event'}
		{every > 1 ? `Every ${ordinal(every)} ${label}` : `On ${label}`}
	{:else}
		{TRIGGER_LABELS[agent.triggerType]}
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
		<PageHeader
			title="Agents"
			icon={BotIcon}
			description="Assistants that run on a schedule, on events, over HTTP or on demand, and personas you can chat with."
		>
			{#snippet actions()}
				<!-- The empty state carries these actions until there is something listed. -->
				{#if data.agents.some((agent) => agent.userId !== null)}
					<Button href={resolve('/agents/new')}><PlusIcon class="size-4" />New agent</Button>
				{/if}
			{/snippet}
		</PageHeader>

		{#each sections as section (section.title)}
			{#if section.agents.length > 0 || section.title === 'Your agents'}
				<SettingsSection title={section.title} description={section.description} flush>
					{#if section.agents.length === 0}
						<EmptyState
							compact
							icon={BotIcon}
							title="No agents yet"
							description="Create an agent to automate work on a schedule, react to events, or chat as a persona."
						>
							<Button size="sm" href={resolve('/agents/new')}>
								<PlusIcon class="size-4" />New agent
							</Button>
						</EmptyState>
					{:else}
						<ul class="divide-y divide-border/60" aria-label={section.title}>
							{#each section.agents as agent (agent.id)}
								{@const running = data.runningAgentIds.includes(agent.id)}
								<SettingsListItem
									title={agent.name}
									href={resolve(`/agents/${agent.id}`)}
									muted={!agent.enabled}
								>
									{#snippet leading()}
										{#if agent.codingTarget}
											<CodeXmlIcon class="size-4" />
										{:else if agent.triggerType === 'persona'}
											<MessageCircleIcon class="size-4" />
										{:else}
											<BotIcon class="size-4" />
										{/if}
									{/snippet}
									{#snippet badges()}
										{#if running}
											<Badge variant="outline" class="border-info/50 text-info-foreground">
												<LoaderCircleIcon class="size-3 animate-spin" />Running
											</Badge>
										{/if}
										{#if agent.codingTarget}
											<Badge
												variant="outline"
												title="Runs as a coding task in {agent.codingTarget.projectTitle}"
											>
												Coding · {agent.codingTarget.projectTitle}
											</Badge>
										{/if}
									{/snippet}
									{#snippet meta()}
										<span class="text-foreground/80">{@render triggerLabel(agent)}</span>
										{#if agent.enabled && agent.nextRunAt}
											· <span title={formatDateTime(agent.nextRunAt, data.timeFormat)}
												>Next {formatDateTime(agent.nextRunAt, data.timeFormat)}</span
											>
										{/if}
										{#if agent.lastRunAt}
											· <span title={formatDateTime(agent.lastRunAt, data.timeFormat)}
												>Last ran {formatTimeAgo(agent.lastRunAt)}</span
											>
										{/if}
									{/snippet}
									{@const blurb = agent.description.replace(/\s*\(built-in\)(?=\.?$)/i, '')}
									{#if blurb}
										<p class="line-clamp-2 text-xs text-pretty text-muted-foreground" title={blurb}>
											{blurb}
										</p>
									{/if}
									{#snippet trailing()}
										<Button
											variant="ghost"
											size="icon-sm"
											class="hidden sm:inline-flex"
											title="Run now"
											aria-label="Run {agent.name} now"
											disabled={runBusy !== null || running}
											onclick={() => runNow(agent)}
										>
											{#if runBusy === agent.id}
												<LoaderCircleIcon class="size-4 animate-spin" />
											{:else}
												<PlayIcon class="size-4" />
											{/if}
										</Button>
										<Switch
											checked={agent.enabled}
											aria-label="Enable {agent.name}"
											disabled={toggleBusy !== null}
											onCheckedChange={(checked) => toggleAgent(agent, checked)}
										/>
										<RowMenu label="Actions for {agent.name}" items={menuItems(agent, running)} />
									{/snippet}
								</SettingsListItem>
							{/each}
						</ul>
					{/if}
				</SettingsSection>
			{/if}
		{/each}
	</div>
</div>

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete agent?</Dialog.Title>
			<Dialog.Description>
				"{deleteTarget?.name}" and its run history will be permanently deleted.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteBusy} onclick={confirmDelete}>
				{deleteBusy ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
