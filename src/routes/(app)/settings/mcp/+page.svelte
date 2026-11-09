<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import BlocksIcon from '@lucide/svelte/icons/blocks';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MessageSquareTextIcon from '@lucide/svelte/icons/message-square-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import BotIcon from '@lucide/svelte/icons/bot';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import ImageIcon from '@lucide/svelte/icons/image';
	import HourglassIcon from '@lucide/svelte/icons/hourglass';
	import CalculatorIcon from '@lucide/svelte/icons/calculator';
	import CloudSunIcon from '@lucide/svelte/icons/cloud-sun';
	import type { Component } from 'svelte';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PackageSearchIcon from '@lucide/svelte/icons/package-search';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import RowMenu, { type RowMenuItem } from '$lib/components/app/settings/RowMenu.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { McpServerInfo } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function menuItems(server: McpServerInfo): RowMenuItem[] {
		const test: RowMenuItem = {
			label: 'Test connection',
			icon: PlugZapIcon,
			disabled: testBusyId === server.id,
			onSelect: () => runTest(server)
		};
		const deferred = (loadModeOverride[server.id] ?? server.loadMode) === 'deferred';
		const loadMode: RowMenuItem = deferred
			? {
					label: 'Always load tools',
					icon: ZapIcon,
					onSelect: () => setLoadMode(server, 'always')
				}
			: {
					label: 'Load tools on demand',
					icon: PackageSearchIcon,
					onSelect: () => setLoadMode(server, 'deferred')
				};
		if (server.builtin) return [test, loadMode];
		return [
			test,
			loadMode,
			{ label: 'Edit', icon: PencilIcon, onSelect: () => openEdit(server) },
			'separator',
			{ label: 'Delete', icon: Trash2Icon, destructive: true, onSelect: () => openDelete(server) }
		];
	}

	type ConfigurableTransport = 'http' | 'sse' | 'stdio';
	type TestResult = {
		name: string;
		ok: boolean;
		tools: { name: string; description?: string }[];
		error?: string;
	};

	const transportLabels: Record<ConfigurableTransport, string> = {
		http: 'HTTP',
		sse: 'SSE',
		stdio: 'stdio (local command)'
	};

	let addOpen = $state(false);
	let addName = $state('');
	let addTransport = $state<ConfigurableTransport>('http');
	let addUrl = $state('');
	let addToken = $state('');
	let addCommand = $state('');
	let addArgs = $state('');
	let addBusy = $state(false);

	let editOpen = $state(false);
	let editId = $state<string | null>(null);
	let editName = $state('');
	let editTransport = $state<ConfigurableTransport>('http');
	let editUrl = $state('');
	let editToken = $state('');
	let editCommand = $state('');
	let editArgs = $state('');
	let editBusy = $state(false);

	/** One argument per line; blank lines are ignored. */
	function parseArgs(value: string): string[] {
		return value
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}

	function connectionBody(
		transport: ConfigurableTransport,
		url: string,
		command: string,
		args: string
	): Record<string, unknown> {
		return transport === 'stdio'
			? { transport, command, args: parseArgs(args) }
			: { transport, url };
	}

	const argsPlaceholder = '-y\n@modelcontextprotocol/server-everything';
	const stdioHint =
		'Runs the command on the Chatty host (no shell) each time tools are loaded, with a minimal environment (PATH, HOME, …). Only add commands you trust.';

	function connectionLabel(server: McpServerInfo): string {
		if (server.transport === 'stdio') {
			return [server.command ?? '', ...server.args].join(' ').trim();
		}
		return server.url ?? '';
	}

	/** One-line purpose for each bundled server, shown under its name. */
	const BUILTIN_PURPOSE: Record<string, string> = {
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

	const BUILTIN_ICON: Record<string, Component<{ class?: string }>> = {
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

	const builtinServers = $derived(data.servers.filter((s) => s.builtin));
	const customServers = $derived(data.servers.filter((s) => !s.builtin));

	let deleteOpen = $state(false);
	let deleteTarget = $state<McpServerInfo | null>(null);
	let deleteBusy = $state(false);

	let testBusyId = $state<string | null>(null);
	let testOpen = $state(false);
	let testResult = $state<TestResult | null>(null);

	let enabledOverride = $state<Record<string, boolean>>({});
	let loadModeOverride = $state<Record<string, McpServerInfo['loadMode']>>({});

	async function api(path: string, method: string, body?: unknown): Promise<Response> {
		const res = await fetch(path, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!res.ok) {
			const payload = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(payload?.message ?? `Request failed (${res.status})`);
		}
		return res;
	}

	function resetAddForm() {
		addName = '';
		addTransport = 'http';
		addUrl = '';
		addToken = '';
		addCommand = '';
		addArgs = '';
	}

	function openAdd() {
		resetAddForm();
		addOpen = true;
	}

	async function submitAdd(event: SubmitEvent) {
		event.preventDefault();
		addBusy = true;
		try {
			await api('/api/mcp-servers', 'POST', {
				name: addName,
				...connectionBody(addTransport, addUrl, addCommand, addArgs),
				...(addTransport === 'stdio' ? {} : { token: addToken || null })
			});
			toast.success(`Server "${addName}" added`);
			addOpen = false;
			resetAddForm();
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to add server');
		} finally {
			addBusy = false;
		}
	}

	function openEdit(server: McpServerInfo) {
		editId = server.id;
		editName = server.name;
		editTransport =
			server.transport === 'sse' || server.transport === 'stdio' ? server.transport : 'http';
		editUrl = server.url ?? '';
		editToken = '';
		editCommand = server.command ?? '';
		editArgs = server.args.join('\n');
		editOpen = true;
	}

	async function submitEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editId) return;
		editBusy = true;
		try {
			await api(`/api/mcp-servers/${editId}`, 'PATCH', {
				name: editName,
				...connectionBody(editTransport, editUrl, editCommand, editArgs),
				...(editToken && editTransport !== 'stdio' ? { token: editToken } : {})
			});
			toast.success('Server updated');
			editOpen = false;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update server');
		} finally {
			editBusy = false;
		}
	}

	async function toggleEnabled(server: McpServerInfo, enabled: boolean) {
		enabledOverride[server.id] = enabled;
		try {
			await api(`/api/mcp-servers/${server.id}`, 'PATCH', { enabled });
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update server');
		} finally {
			delete enabledOverride[server.id];
		}
	}

	async function setLoadMode(server: McpServerInfo, loadMode: McpServerInfo['loadMode']) {
		loadModeOverride[server.id] = loadMode;
		try {
			await api(`/api/mcp-servers/${server.id}`, 'PATCH', { loadMode });
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update server');
		} finally {
			delete loadModeOverride[server.id];
		}
	}

	async function runTest(server: McpServerInfo) {
		testBusyId = server.id;
		try {
			const res = await api(`/api/mcp-servers/${server.id}/test`, 'POST');
			testResult = { name: server.name, ...((await res.json()) as Omit<TestResult, 'name'>) };
			testOpen = true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Connection test failed');
		} finally {
			testBusyId = null;
		}
	}

	function openDelete(server: McpServerInfo) {
		deleteTarget = server;
		deleteOpen = true;
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleteBusy = true;
		try {
			await api(`/api/mcp-servers/${deleteTarget.id}`, 'DELETE');
			toast.success(`Server "${deleteTarget.name}" deleted`);
			deleteOpen = false;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete server');
		} finally {
			deleteBusy = false;
		}
	}
</script>

<svelte:head><title>MCP servers · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="MCP servers"
	description="Model Context Protocol servers whose tools are available in chats and agent runs. Tools of on-demand servers stay out of the prompt until the model searches for them, as do a few rarely used built-in tools such as creating skills."
>
	{#snippet actions()}
		<Button onclick={openAdd}><PlusIcon class="size-4" />Add server</Button>
	{/snippet}
</SettingsHeader>

{#snippet serverRow(server: McpServerInfo)}
	{@const enabled = enabledOverride[server.id] ?? server.enabled}
	{@const connection = connectionLabel(server)}
	<SettingsListItem
		title={server.name}
		muted={!enabled}
		onclick={server.builtin ? undefined : () => openEdit(server)}
	>
		{#snippet leading()}
			{@const Icon = (server.builtin && BUILTIN_ICON[server.name]) || BlocksIcon}
			<Icon class="size-4" />
		{/snippet}
		{#snippet badges()}
			{#if !server.builtin && server.transport !== 'builtin'}
				<Badge variant="outline">{transportLabels[server.transport]}</Badge>
			{/if}
			{#if (loadModeOverride[server.id] ?? server.loadMode) === 'deferred'}
				<Badge
					variant="secondary"
					title="Tools stay out of the prompt until the model loads them with search_tools"
				>
					On demand
				</Badge>
			{/if}
		{/snippet}
		{#snippet meta()}
			{#if connection}
				<span class="font-mono" title={connection}>{connection}</span>
			{:else if BUILTIN_PURPOSE[server.name]}
				{BUILTIN_PURPOSE[server.name]}
			{/if}
		{/snippet}
		{#snippet trailing()}
			{#if testBusyId === server.id}
				<span class="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
					<Loader2Icon class="size-4 animate-spin" />Testing…
				</span>
			{/if}
			<Switch
				checked={enabled}
				aria-label="Enable {server.name}"
				onCheckedChange={(checked) => toggleEnabled(server, checked)}
			/>
			<RowMenu label="Actions for {server.name}" items={menuItems(server)} />
		{/snippet}
	</SettingsListItem>
{/snippet}

<SettingsSection
	title="Your servers"
	description="Servers you've connected over HTTP, SSE or stdio."
	flush
>
	{#if customServers.length === 0}
		<div class="flex flex-col items-center gap-3 px-6 py-8 text-center">
			<div
				class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
			>
				<BlocksIcon class="size-5" />
			</div>
			<div class="flex flex-col gap-1">
				<p class="text-sm font-medium">No servers added yet</p>
				<p class="text-sm text-muted-foreground">
					Add a remote server over HTTP or run a local one over stdio.
				</p>
			</div>
			<Button size="sm" variant="outline" onclick={openAdd}
				><PlusIcon class="size-4" />Add server</Button
			>
		</div>
	{:else}
		<ul class="divide-y divide-border/60" aria-label="Your MCP servers">
			{#each customServers as server (server.id)}
				{@render serverRow(server)}
			{/each}
		</ul>
	{/if}
</SettingsSection>

{#if builtinServers.length > 0}
	<SettingsSection
		title="Built-in"
		description="Tools that ship with Chatty. Turn off any you don't want models to use."
		flush
	>
		<ul class="divide-y divide-border/60" aria-label="Built-in MCP servers">
			{#each builtinServers as server (server.id)}
				{@render serverRow(server)}
			{/each}
		</ul>
	</SettingsSection>
{/if}

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Add server</Dialog.Title>
			<Dialog.Description>
				Connect a remote MCP server over HTTP or SSE (tokens are encrypted at rest), or run a local
				command over stdio.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitAdd} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="add-name">Name</Label>
				<Input id="add-name" bind:value={addName} required maxlength={64} placeholder="my-server" />
			</div>
			<div class="flex flex-col gap-2">
				<Label>Transport</Label>
				<Select.Root type="single" bind:value={addTransport}>
					<Select.Trigger class="w-full">{transportLabels[addTransport]}</Select.Trigger>
					<Select.Content>
						<Select.Item value="http">{transportLabels.http}</Select.Item>
						<Select.Item value="sse">{transportLabels.sse}</Select.Item>
						<Select.Item value="stdio">{transportLabels.stdio}</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
			{#if addTransport === 'stdio'}
				<div class="flex flex-col gap-2">
					<Label for="add-command">Command</Label>
					<Input id="add-command" bind:value={addCommand} required placeholder="npx" />
				</div>
				<div class="flex flex-col gap-2">
					<Label for="add-args">Arguments (one per line)</Label>
					<Textarea id="add-args" bind:value={addArgs} rows={3} placeholder={argsPlaceholder} />
				</div>
				<p class="text-xs text-muted-foreground">{stdioHint}</p>
			{:else}
				<div class="flex flex-col gap-2">
					<Label for="add-url">URL</Label>
					<Input
						id="add-url"
						type="url"
						bind:value={addUrl}
						required
						placeholder="https://example.com/mcp"
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="add-token">Token (optional)</Label>
					<Input id="add-token" type="password" bind:value={addToken} autocomplete="off" />
				</div>
			{/if}
			<Dialog.Footer>
				<Button type="submit" disabled={addBusy}>{addBusy ? 'Adding…' : 'Add server'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={editOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Edit server</Dialog.Title>
			<Dialog.Description>Update the connection details for this MCP server.</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitEdit} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="edit-name">Name</Label>
				<Input id="edit-name" bind:value={editName} required maxlength={64} />
			</div>
			<div class="flex flex-col gap-2">
				<Label>Transport</Label>
				<Select.Root type="single" bind:value={editTransport}>
					<Select.Trigger class="w-full">{transportLabels[editTransport]}</Select.Trigger>
					<Select.Content>
						<Select.Item value="http">{transportLabels.http}</Select.Item>
						<Select.Item value="sse">{transportLabels.sse}</Select.Item>
						<Select.Item value="stdio">{transportLabels.stdio}</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
			{#if editTransport === 'stdio'}
				<div class="flex flex-col gap-2">
					<Label for="edit-command">Command</Label>
					<Input id="edit-command" bind:value={editCommand} required />
				</div>
				<div class="flex flex-col gap-2">
					<Label for="edit-args">Arguments (one per line)</Label>
					<Textarea id="edit-args" bind:value={editArgs} rows={3} />
				</div>
				<p class="text-xs text-muted-foreground">{stdioHint}</p>
			{:else}
				<div class="flex flex-col gap-2">
					<Label for="edit-url">URL</Label>
					<Input id="edit-url" type="url" bind:value={editUrl} required />
				</div>
				<div class="flex flex-col gap-2">
					<Label for="edit-token">Token</Label>
					<Input
						id="edit-token"
						type="password"
						bind:value={editToken}
						autocomplete="off"
						placeholder="Leave empty to keep current token"
					/>
				</div>
			{/if}
			<Dialog.Footer>
				<Button type="submit" disabled={editBusy}>{editBusy ? 'Saving…' : 'Save changes'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete server {deleteTarget?.name}?</Dialog.Title>
			<Dialog.Description>
				This removes the server and its stored token. Conversations keep their history.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteBusy} onclick={confirmDelete}>
				{deleteBusy ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={testOpen}>
	<Dialog.Content class="flex max-h-[85vh] flex-col">
		<Dialog.Header class="shrink-0">
			<Dialog.Title>Connection test — {testResult?.name}</Dialog.Title>
			<Dialog.Description>
				{#if testResult?.ok}
					Connected successfully. Tools exposed by this server:
				{:else}
					The connection failed.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		{#if testResult}
			<div class="min-h-0 overflow-y-auto">
				{#if testResult.ok}
					{#if testResult.tools.length > 0}
						<ul class="flex flex-col gap-2">
							{#each testResult.tools as tool (tool.name)}
								<li class="flex flex-col gap-0.5">
									<Badge variant="secondary" class="self-start">{tool.name}</Badge>
									{#if tool.description}
										<span class="text-xs text-muted-foreground">{tool.description}</span>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-sm text-muted-foreground">The server exposes no tools.</p>
					{/if}
				{:else}
					<p class="text-sm wrap-break-word text-destructive">
						{testResult.error ?? 'Unknown error'}
					</p>
				{/if}
			</div>
		{/if}
		<Dialog.Footer class="shrink-0">
			<Button variant="outline" onclick={() => (testOpen = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
