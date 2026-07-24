<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import BotIcon from '@lucide/svelte/icons/bot';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
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

	function ordinal(n: number): string {
		const mod100 = n % 100;
		if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
		switch (n % 10) {
			case 1:
				return `${n}st`;
			case 2:
				return `${n}nd`;
			case 3:
				return `${n}rd`;
			default:
				return `${n}th`;
		}
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

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
		<div class="flex items-center justify-between">
			<h1 class="flex items-center gap-2 text-xl font-semibold">
				<BotIcon class="size-5" />
				Agents
			</h1>
			<Button href={resolve('/agents/new')}>New agent</Button>
		</div>

		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Agent</Table.Head>
					<Table.Head>Trigger</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head>Next run</Table.Head>
					<Table.Head>Last run</Table.Head>
					<Table.Head class="text-right">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.agents as agent (agent.id)}
					<Table.Row>
						<Table.Cell class="max-w-72">
							<div class="flex items-center gap-2">
								<span class="truncate font-medium" title={agent.name}>{agent.name}</span>
								{#if data.runningAgentIds.includes(agent.id)}
									<LoaderCircleIcon
										class="size-3.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400"
										title="Running"
									/>
								{/if}
								{#if agent.userId === null}
									<Badge variant="outline">Built-in</Badge>
								{/if}
							</div>
							{#if agent.description}
								<p class="line-clamp-2 text-sm text-muted-foreground" title={agent.description}>
									{agent.description}
								</p>
							{/if}
						</Table.Cell>
						<Table.Cell>
							{#if agent.triggerType === 'schedule'}
								{@const schedule = describeCron(agent.triggerConfig.cron, data.timeFormat)}
								{#if schedule}
									<Badge variant="secondary">{schedule}</Badge>
								{:else}
									<Badge variant="secondary">{agent.triggerType}</Badge>
								{/if}
							{:else if agent.triggerType === 'event'}
								<Badge variant="secondary"
									>{@const every = agent.triggerConfig.every ?? 1}
									{every > 1
										? `Every ${ordinal(every)} ${agent.triggerConfig.event}`
										: `On ${agent.triggerConfig.event}`}</Badge
								>
							{:else}
								<Badge variant="secondary">{agent.triggerType}</Badge>
							{/if}
						</Table.Cell>
						<Table.Cell>
							<div class="flex items-center gap-2">
								<Switch
									checked={agent.enabled}
									disabled={toggleBusy !== null}
									onCheckedChange={(checked) => toggleAgent(agent, checked)}
								/>
								<span class="text-sm text-muted-foreground">
									{agent.enabled ? 'Enabled' : 'Disabled'}
								</span>
							</div>
						</Table.Cell>
						<Table.Cell class="whitespace-nowrap text-muted-foreground">
							{agent.nextRunAt ? formatDateTime(agent.nextRunAt, data.timeFormat) : '—'}
						</Table.Cell>
						<Table.Cell class="whitespace-nowrap text-muted-foreground">
							{#if agent.lastRunAt}
								<span title={formatDateTime(agent.lastRunAt, data.timeFormat)}>
									{formatTimeAgo(agent.lastRunAt)}
								</span>
							{:else}
								—
							{/if}
						</Table.Cell>
						<Table.Cell class="text-right whitespace-nowrap">
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon"
											title="Actions"
											aria-label="Actions"
										>
											<EllipsisIcon class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item disabled={runBusy !== null} onclick={() => runNow(agent)}>
										{#if runBusy === agent.id}
											<LoaderCircleIcon class="size-4 animate-spin" />
											Starting…
										{:else}
											Run now
										{/if}
									</DropdownMenu.Item>
									<DropdownMenu.Item>
										{#snippet child({ props })}
											<a href={resolve(`/agents/${agent.id}/runs`)} {...props}>Runs</a>
										{/snippet}
									</DropdownMenu.Item>
									{#if agent.userId !== null}
										<DropdownMenu.Separator />
										<DropdownMenu.Item>
											{#snippet child({ props })}
												<a href={resolve(`/agents/${agent.id}`)} {...props}>Edit</a>
											{/snippet}
										</DropdownMenu.Item>
										<DropdownMenu.Item variant="destructive" onclick={() => (deleteTarget = agent)}>
											Delete
										</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={6} class="text-center text-muted-foreground">
							No agents yet. Create one to get started.
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
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
