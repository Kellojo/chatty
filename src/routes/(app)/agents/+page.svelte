<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import BotIcon from '@lucide/svelte/icons/bot';
	import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import MousePointerClickIcon from '@lucide/svelte/icons/mouse-pointer-click';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import ZapIcon from '@lucide/svelte/icons/zap';
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
	import { SvelteSet } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import RowMenu, { type RowMenuItem } from '$lib/components/app/settings/RowMenu.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import {
		agentDisplayName,
		EVENT_LABELS,
		isAgentSlug,
		formatRunError,
		isStoppedRun,
		ordinal,
		TRIGGER_LABELS
	} from '$lib/agent-labels.js';
	import { describeCron } from '$lib/cron.js';
	import { formatDateTime, formatTimeAgo, formatTimeUntil } from '$lib/datetime.js';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import type { Agent } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Agents with a run request or an enable toggle in flight; only those rows wait on it.
	const runBusy = new SvelteSet<string>();
	const toggleBusy = new SvelteSet<string>();
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

	/** Rows that want something from you first, switched-off ones last; otherwise the server's order. */
	function rank(agent: Agent): number {
		const last = data.lastRuns[agent.id];
		if (last?.status === 'awaiting_input') return 0;
		if (last?.status === 'failed' && !isStoppedRun(last)) return 1;
		return agent.enabled ? 2 : 3;
	}

	const sorted = $derived(data.agents.toSorted((a, b) => rank(a) - rank(b)));

	const sections = $derived([
		{
			title: 'Your agents',
			description: undefined,
			agents: sorted.filter((agent) => agent.userId !== null)
		},
		{
			title: 'Built-in',
			description:
				'Included with Chatty. You can switch them on or off and run them, but not edit them.',
			agents: sorted.filter((agent) => agent.userId === null)
		}
	]);

	function menuItems(agent: Agent, running: boolean): RowMenuItem[] {
		const builtin = agent.userId === null;
		const items: RowMenuItem[] = [];
		// A persona only does something inside a chat; there is nothing to run on its own.
		if (agent.triggerType !== 'persona') {
			items.push({
				label: running ? 'Running…' : 'Run now',
				icon: PlayIcon,
				disabled: runBusy.has(agent.id) || running,
				onSelect: () => runNow(agent)
			});
		}
		items.push(
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
		);
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
		if (runBusy.has(agent.id)) return;
		runBusy.add(agent.id);
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
			runBusy.delete(agent.id);
		}
	}

	async function toggleAgent(agent: Agent, checked: boolean) {
		if (toggleBusy.has(agent.id)) return;
		toggleBusy.add(agent.id);
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
			toggleBusy.delete(agent.id);
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
	{:else if agent.triggerType === 'persona'}
		Chat persona
	{:else if agent.triggerType === 'http'}
		On HTTP request
	{:else}
		{TRIGGER_LABELS[agent.triggerType]} only
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
		<PageHeader
			title="Agents"
			icon={BotIcon}
			description="Assistants that run on a schedule, on events or on demand, and personas you can chat with."
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
								{@const last = data.lastRuns[agent.id]}
								<SettingsListItem
									title={agentDisplayName(agent.name)}
									titleAttr={agent.name}
									href={resolve(`/agents/${agent.id}`)}
									muted={!agent.enabled}
								>
									{#snippet leading()}
										{#if agent.codingTarget}
											<CodeXmlIcon class="size-4" />
										{:else if agent.triggerType === 'persona'}
											<MessageCircleIcon class="size-4" />
										{:else if agent.triggerType === 'schedule'}
											<CalendarClockIcon class="size-4" />
										{:else if agent.triggerType === 'event'}
											<ZapIcon class="size-4" />
										{:else if agent.triggerType === 'http'}
											<WebhookIcon class="size-4" />
										{:else}
											<MousePointerClickIcon class="size-4" />
										{/if}
									{/snippet}
									{#snippet badges()}
										{@const display = agentDisplayName(agent.name)}
										{#if running}
											{@const chat =
												last?.status === 'running' && last.conversationId
													? resolve(`/chat/${last.conversationId}`)
													: undefined}
											<Badge
												href={chat}
												aria-label={chat ? `Open the running chat of ${display}` : undefined}
												variant="outline"
												class="relative z-10 border-info/50 text-info-foreground [a&]:hover:bg-info/10"
											>
												<LoaderCircleIcon class="size-3 animate-spin" />Running
											</Badge>
										{:else if last?.status === 'awaiting_input' && last.conversationId}
											<!-- Above the row's stretched link, so it opens the chat that waits on a reply. -->
											<Badge
												href={resolve(`/chat/${last.conversationId}`)}
												aria-label="Reply to {display}"
												variant="outline"
												class="relative z-10 border-warning/50 text-warning-foreground [a&]:hover:bg-warning/10"
												title="The latest run asked a question; open its chat to reply"
											>
												<CircleAlertIcon class="size-3" />Needs your reply
											</Badge>
										{:else if last?.status === 'failed' && !isStoppedRun(last)}
											<Badge
												href={resolve(`/agents/${agent.id}/runs`)}
												aria-label="See the failed run of {display}"
												variant="outline"
												class="relative z-10 border-destructive/40 text-destructive [a&]:hover:bg-destructive/10"
												title="See this agent's runs"
											>
												<CircleXIcon class="size-3" />Last run failed
											</Badge>
										{/if}
										{#if agent.codingTarget}
											<!-- A fact about the agent, not a status: quieter than the status chips. -->
											<Badge
												variant="secondary"
												class="font-normal text-muted-foreground"
												title="Runs as a coding task in {agent.codingTarget.projectTitle}"
											>
												Coding · {agent.codingTarget.projectTitle}
											</Badge>
										{/if}
									{/snippet}
									{#snippet meta()}
										<!-- Phones stack the facts; wider screens run them together with trailing dots, each fact
										     wrapping as a whole so a line never starts with a separator. -->
										<span
											class="flex flex-col sm:inline-flex sm:flex-row sm:flex-wrap sm:gap-x-1 sm:[&>span:not(:last-child)]:after:ml-1 sm:[&>span:not(:last-child)]:after:content-['·']"
										>
											{#if isAgentSlug(agent.name)}
												<!-- Phones: the slug is on the agent's page. -->
												<span class="max-sm:hidden"
													><span class="font-mono">{agent.name}</span></span
												>
											{/if}
											<span class={agent.enabled ? 'text-foreground/80' : undefined}
												>{@render triggerLabel(agent)}</span
											>
											{#if agent.enabled && agent.nextRunAt}
												<span
													class="whitespace-nowrap"
													title={formatDateTime(agent.nextRunAt, data.timeFormat)}
													>Next {formatTimeUntil(agent.nextRunAt)}</span
												>
											{/if}
											{#if agent.lastRunAt}
												<!-- Phones keep one timing fact: the next run when there is one. -->
												<span
													class={[
														'whitespace-nowrap',
														agent.enabled && agent.nextRunAt && 'max-sm:hidden'
													]}
													title={formatDateTime(agent.lastRunAt, data.timeFormat)}
													>Last ran {formatTimeAgo(agent.lastRunAt)}</span
												>
											{/if}
										</span>
									{/snippet}
									{@const blurb = agent.description.replace(/\s*\(built-in\)(?=\.?$)/i, '')}
									{@const failure =
										last?.status === 'failed' && !running && !isStoppedRun(last)
											? formatRunError(last.error)
											: null}
									{#if blurb}
										<!-- Phones: name and schedule are enough here; the detail page has the description. -->
										<p
											class="line-clamp-2 text-xs text-pretty text-muted-foreground max-sm:hidden"
											title={blurb}
										>
											{blurb}
										</p>
									{/if}
									{#if failure}
										<p class="truncate text-xs text-muted-foreground max-sm:hidden" title={failure}>
											<span class="font-medium text-foreground/80">Error:</span>
											{failure}
										</p>
									{/if}
									{#snippet trailing()}
										{#if agent.triggerType === 'persona'}
											<!-- Keeps the switches lined up with the rows that have a Run button. -->
											<span class="hidden size-8 sm:block" aria-hidden="true"></span>
										{:else}
											<Button
												variant="ghost"
												size="icon-sm"
												class="hidden sm:inline-flex"
												title="Run now"
												aria-label={running
													? `${agentDisplayName(agent.name)} is running`
													: `Run ${agentDisplayName(agent.name)} now`}
												disabled={runBusy.has(agent.id) || running}
												onclick={() => runNow(agent)}
											>
												{#if runBusy.has(agent.id)}
													<LoaderCircleIcon class="size-4 animate-spin" />
												{:else}
													<PlayIcon class="size-4" />
												{/if}
											</Button>
										{/if}
										<Switch
											checked={agent.enabled}
											aria-label="Enable {agentDisplayName(agent.name)}"
											disabled={toggleBusy.has(agent.id)}
											onCheckedChange={(checked) => toggleAgent(agent, checked)}
										/>
										<RowMenu
											label="Actions for {agentDisplayName(agent.name)}"
											items={menuItems(agent, running)}
										/>
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
				"{deleteTarget ? agentDisplayName(deleteTarget.name) : ''}" and its run history will be
				permanently deleted.
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
