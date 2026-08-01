<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { McpServerInfo } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type RemoteTransport = 'http' | 'sse';
	type TestResult = {
		name: string;
		ok: boolean;
		tools: { name: string; description?: string }[];
		error?: string;
	};

	const transportLabels: Record<RemoteTransport, string> = {
		http: 'HTTP',
		sse: 'SSE'
	};

	let addOpen = $state(false);
	let addName = $state('');
	let addTransport = $state<RemoteTransport>('http');
	let addUrl = $state('');
	let addToken = $state('');
	let addBusy = $state(false);

	let editOpen = $state(false);
	let editId = $state<string | null>(null);
	let editName = $state('');
	let editTransport = $state<RemoteTransport>('http');
	let editUrl = $state('');
	let editToken = $state('');
	let editBusy = $state(false);

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
				transport: addTransport,
				url: addUrl,
				token: addToken || null
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
		editTransport = server.transport === 'sse' ? 'sse' : 'http';
		editUrl = server.url ?? '';
		editToken = '';
		editOpen = true;
	}

	async function submitEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editId) return;
		editBusy = true;
		try {
			await api(`/api/mcp-servers/${editId}`, 'PATCH', {
				name: editName,
				transport: editTransport,
				url: editUrl,
				...(editToken ? { token: editToken } : {})
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

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between">
		<div class="flex flex-col gap-1">
			<h2 class="text-xl font-semibold">MCP servers</h2>
			<p class="text-sm text-muted-foreground">
				Model Context Protocol servers available to chat and agent modes.
			</p>
		</div>
		<Button onclick={openAdd}>Add server</Button>
	</div>

	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head>Name</Table.Head>
				<Table.Head>Transport</Table.Head>
				<Table.Head>URL</Table.Head>
				<Table.Head>Enabled</Table.Head>
				<Table.Head class="text-right">Actions</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each data.servers as server (server.id)}
				<Table.Row>
					<Table.Cell class="max-w-40 font-medium" title={server.name}>
						<div class="flex items-center gap-2">
							<span class="truncate">{server.name}</span>
							{#if server.builtin}
								<Badge variant="secondary" class="shrink-0">bundled</Badge>
							{/if}
						</div>
					</Table.Cell>
					<Table.Cell><Badge variant="outline">{server.transport}</Badge></Table.Cell>
					<Table.Cell class="max-w-48 truncate text-muted-foreground" title={server.url ?? ''}>
						{server.url ?? '—'}
					</Table.Cell>
					<Table.Cell>
						<Switch
							checked={enabledOverride[server.id] ?? server.enabled}
							onCheckedChange={(checked) => toggleEnabled(server, checked)}
						/>
					</Table.Cell>
					<Table.Cell class="text-right whitespace-nowrap">
						<div class="flex justify-end gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={testBusyId === server.id}
								onclick={() => runTest(server)}
							>
								{#if testBusyId === server.id}
									<Loader2Icon class="size-4 animate-spin" />
									Testing…
								{:else}
									Test
								{/if}
							</Button>
							{#if !server.builtin}
								<Button variant="outline" size="sm" onclick={() => openEdit(server)}>Edit</Button>
								<Button variant="destructive" size="sm" onclick={() => openDelete(server)}>
									Delete
								</Button>
							{/if}
						</div>
					</Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row>
					<Table.Cell colspan={5} class="text-center text-muted-foreground">
						No MCP servers configured.
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Add server</Dialog.Title>
			<Dialog.Description>
				Connect a remote MCP server over HTTP or SSE. Tokens are encrypted at rest.
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
					</Select.Content>
				</Select.Root>
			</div>
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
					</Select.Content>
				</Select.Root>
			</div>
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
