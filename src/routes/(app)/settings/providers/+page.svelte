<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type ProviderType = 'anthropic' | 'openai-compatible';

	let addOpen = $state(false);
	let addName = $state('');
	let addType = $state<ProviderType>('anthropic');
	let addBaseUrl = $state('');
	let addApiKey = $state('');
	let addBusy = $state(false);

	let editId = $state<string | null>(null);
	let editName = $state('');
	let editType = $state<ProviderType>('anthropic');
	let editBaseUrl = $state('');
	let editApiKey = $state('');
	let editBusy = $state(false);

	let deleteId = $state<string | null>(null);
	let deleteBusy = $state(false);

	const typeLabels: Record<ProviderType, string> = {
		anthropic: 'Anthropic',
		'openai-compatible': 'OpenAI-compatible'
	};

	interface ProviderPreset {
		label: string;
		baseUrl: string;
	}

	const presets: Record<string, ProviderPreset> = {
		custom: { label: 'Custom', baseUrl: '' },
		openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
		openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
		'lm-studio': { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
		ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
		groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
		together: { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
		deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
		mistral: { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' }
	};

	let addPreset = $state('custom');

	function applyPreset(presetKey: string) {
		addPreset = presetKey;
		if (presetKey !== 'custom') {
			addBaseUrl = presets[presetKey].baseUrl;
			if (!addName) addName = presets[presetKey].label;
		}
	}

	function openAdd() {
		addName = '';
		addType = 'anthropic';
		addPreset = 'custom';
		addBaseUrl = '';
		addApiKey = '';
		addOpen = true;
	}

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

	async function submitAdd(event: SubmitEvent) {
		event.preventDefault();
		addBusy = true;
		try {
			await api('/api/providers', 'POST', {
				name: addName,
				type: addType,
				baseUrl: addBaseUrl || null,
				apiKey: addApiKey || null
			});
			toast.success(`Provider "${addName}" added`);
			addOpen = false;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to add provider');
		} finally {
			addBusy = false;
		}
	}

	function openEdit(provider: PageData['providers'][number]) {
		editId = provider.id;
		editName = provider.name;
		editType = provider.type;
		editBaseUrl = provider.baseUrl ?? '';
		editApiKey = '';
	}

	async function submitEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editId) return;
		editBusy = true;
		try {
			await api(`/api/providers/${editId}`, 'PATCH', {
				name: editName,
				baseUrl: editBaseUrl || null,
				...(editApiKey ? { apiKey: editApiKey } : {})
			});
			toast.success('Provider updated');
			editId = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update provider');
		} finally {
			editBusy = false;
		}
	}

	async function toggleEnabled(id: string, enabled: boolean) {
		try {
			await api(`/api/providers/${id}`, 'PATCH', { enabled });
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update provider');
		}
	}

	async function fetchModels(id: string, name: string) {
		const promise = api(`/api/providers/${id}/fetch-models`, 'POST')
			.then(async (res) => {
				const result = (await res.json()) as { added: number; total: number };
				await invalidateAll();
				return `${result.total} models found, ${result.added} new`;
			})
			.catch((e: unknown) => {
				throw e instanceof Error ? e : new Error('Failed to fetch models');
			});
		toast.promise(promise, {
			loading: `Fetching models from ${name}…`,
			success: (msg) => msg,
			error: (e: unknown) => (e instanceof Error ? e.message : 'Failed to fetch models')
		});
	}

	async function confirmDelete() {
		if (!deleteId) return;
		deleteBusy = true;
		try {
			await api(`/api/providers/${deleteId}`, 'DELETE');
			toast.success('Provider deleted');
			deleteId = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete provider');
		} finally {
			deleteBusy = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-semibold">Providers</h2>
		<Button onclick={openAdd}>Add provider</Button>
	</div>

	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head>Name</Table.Head>
				<Table.Head>Type</Table.Head>
				<Table.Head>Base URL</Table.Head>
				<Table.Head>API key</Table.Head>
				<Table.Head>Enabled</Table.Head>
				<Table.Head class="text-right">Actions</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each data.providers as provider (provider.id)}
				<Table.Row>
					<Table.Cell class="max-w-40 truncate font-medium" title={provider.name}>
						{provider.name}
					</Table.Cell>
					<Table.Cell><Badge variant="outline">{typeLabels[provider.type]}</Badge></Table.Cell>
					<Table.Cell
						class="max-w-40 truncate text-muted-foreground"
						title={provider.baseUrl ?? ''}
					>
						{provider.baseUrl ?? '—'}
					</Table.Cell>
					<Table.Cell>{provider.hasApiKey ? '••••••' : '—'}</Table.Cell>
					<Table.Cell>
						<Switch
							checked={provider.enabled}
							onCheckedChange={(checked) => toggleEnabled(provider.id, checked)}
						/>
					</Table.Cell>
					<Table.Cell class="text-right whitespace-nowrap">
						<div class="flex justify-end gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={!provider.enabled}
								onclick={() => fetchModels(provider.id, provider.name)}
							>
								Fetch models
							</Button>
							<Button variant="outline" size="sm" onclick={() => openEdit(provider)}>Edit</Button>
							<Button variant="destructive" size="sm" onclick={() => (deleteId = provider.id)}>
								Delete
							</Button>
						</div>
					</Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row>
					<Table.Cell colspan={6} class="text-center text-muted-foreground">
						No providers configured.
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Add provider</Dialog.Title>
			<Dialog.Description
				>Connect an LLM provider. API keys are encrypted at rest.</Dialog.Description
			>
		</Dialog.Header>
		<form onsubmit={submitAdd} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="add-name">Name</Label>
				<Input id="add-name" bind:value={addName} required maxlength={100} />
			</div>
			<div class="flex flex-col gap-2">
				<Label>Type</Label>
				<Select.Root type="single" bind:value={addType}>
					<Select.Trigger class="w-full">{typeLabels[addType]}</Select.Trigger>
					<Select.Content>
						<Select.Item value="anthropic">{typeLabels.anthropic}</Select.Item>
						<Select.Item value="openai-compatible">{typeLabels['openai-compatible']}</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
			{#if addType === 'openai-compatible'}
				<div class="flex flex-col gap-2">
					<Label>Preset</Label>
					<Select.Root type="single" value={addPreset} onValueChange={applyPreset}>
						<Select.Trigger class="w-full">{presets[addPreset].label}</Select.Trigger>
						<Select.Content>
							{#each Object.entries(presets) as [key, preset] (key)}
								<Select.Item value={key}>{preset.label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="add-baseurl">Base URL</Label>
					<Input
						id="add-baseurl"
						bind:value={addBaseUrl}
						placeholder="https://api.openai.com/v1"
						required
					/>
				</div>
			{/if}
			<div class="flex flex-col gap-2">
				<Label for="add-apikey">API key {addType === 'anthropic' ? '' : '(optional)'}</Label>
				<Input id="add-apikey" type="password" bind:value={addApiKey} autocomplete="off" />
			</div>
			<Dialog.Footer>
				<Button type="submit" disabled={addBusy}>{addBusy ? 'Adding…' : 'Add provider'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={editId !== null} onOpenChange={(open) => !open && (editId = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Edit provider</Dialog.Title>
			<Dialog.Description>Leave the API key blank to keep the current one.</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitEdit} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="edit-name">Name</Label>
				<Input id="edit-name" bind:value={editName} required maxlength={100} />
			</div>
			{#if editType === 'openai-compatible'}
				<div class="flex flex-col gap-2">
					<Label for="edit-baseurl">Base URL</Label>
					<Input id="edit-baseurl" bind:value={editBaseUrl} required />
				</div>
			{/if}
			<div class="flex flex-col gap-2">
				<Label for="edit-apikey">API key</Label>
				<Input
					id="edit-apikey"
					type="password"
					bind:value={editApiKey}
					autocomplete="off"
					placeholder="Unchanged"
				/>
			</div>
			<Dialog.Footer>
				<Button type="submit" disabled={editBusy}>{editBusy ? 'Saving…' : 'Save changes'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteId !== null} onOpenChange={(open) => !open && (deleteId = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete provider?</Dialog.Title>
			<Dialog.Description>
				This also deletes all models registered for this provider. Conversations keep their history.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteId = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteBusy} onclick={confirmDelete}>
				{deleteBusy ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
