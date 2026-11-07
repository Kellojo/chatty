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
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
	import PlusIcon from '@lucide/svelte/icons/plus';
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
		if (server.builtin) return [test];
		return [
			test,
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
			return [server.command ?? '', ...server.args].join(' ').trim() || '—';
		}
		return server.url ?? '—';
	}

	let deleteOpen = $state(false);
	let deleteTarget = $state<McpServerInfo | null>(null);
	let deleteBusy = $state(false);

	let testBusyId = $state<string | null>(null);
	let testOpen = $state(false);
	let testResult = $state<TestResult | null>(null);

	let enabledOverride = $state<Record<string, boolean>>({});

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
	description="Model Context Protocol servers whose tools are available in chats and agent runs."
>
	{#snippet actions()}
		<Button onclick={openAdd}><PlusIcon class="size-4" />Add server</Button>
	{/snippet}
</SettingsHeader>

<SettingsSection flush>
	{#if data.servers.length === 0}
		<div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
			<div
				class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
			>
				<BlocksIcon class="size-5" />
			</div>
			<div class="flex flex-col gap-1">
				<p class="text-sm font-medium">No MCP servers</p>
				<p class="text-sm text-muted-foreground">
					Add a remote server over HTTP or run a local one over stdio.
				</p>
			</div>
			<Button size="sm" onclick={openAdd}><PlusIcon class="size-4" />Add server</Button>
		</div>
	{:else}
		<ul class="divide-y divide-border/60" aria-label="MCP servers">
			{#each data.servers as server (server.id)}
				{@const enabled = enabledOverride[server.id] ?? server.enabled}
				<SettingsListItem title={server.name} muted={!enabled}>
					{#snippet leading()}<BlocksIcon class="size-4" />{/snippet}
					{#snippet badges()}
						<Badge variant="outline"
							>{server.transport === 'builtin'
								? 'Built-in'
								: transportLabels[server.transport]}</Badge
						>
						{#if server.builtin}<Badge variant="secondary">Bundled</Badge>{/if}
					{/snippet}
					{#snippet meta()}
						<span class="font-mono" title={connectionLabel(server)}>{connectionLabel(server)}</span>
					{/snippet}
					{#snippet trailing()}
						<Button
							variant="ghost"
							size="sm"
							class="hidden sm:inline-flex"
							disabled={testBusyId === server.id}
							onclick={() => runTest(server)}
						>
							{#if testBusyId === server.id}
								<Loader2Icon class="size-4 animate-spin" />
								Testing…
							{:else}
								<PlugZapIcon class="size-4" />
								Test
							{/if}
						</Button>
						<Switch
							checked={enabled}
							aria-label="Enable {server.name}"
							onCheckedChange={(checked) => toggleEnabled(server, checked)}
						/>
						<RowMenu label="Actions for {server.name}" items={menuItems(server)} />
					{/snippet}
				</SettingsListItem>
			{/each}
		</ul>
	{/if}
</SettingsSection>

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
