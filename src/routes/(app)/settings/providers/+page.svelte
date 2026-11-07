<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import RowMenu from '$lib/components/app/settings/RowMenu.svelte';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import { resolveProviderBrand } from '$lib/provider-brand.js';
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

<svelte:head><title>Providers · Settings · Chatty</title></svelte:head>

<SettingsHeader title="Providers">
	{#snippet description()}
		LLM APIs Chatty can call. Fetch a provider's models, then choose them in
		<a class="underline underline-offset-4 hover:text-foreground" href={resolve('/settings/models')}
			>Models</a
		>.
	{/snippet}
	{#snippet actions()}
		<Button onclick={openAdd}><PlusIcon class="size-4" />Add provider</Button>
	{/snippet}
</SettingsHeader>

<SettingsSection flush>
	{#if data.providers.length === 0}
		<div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
			<div
				class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
			>
				<PlugIcon class="size-5" />
			</div>
			<div class="flex flex-col gap-1">
				<p class="text-sm font-medium">No providers yet</p>
				<p class="text-sm text-muted-foreground">
					Connect Anthropic, OpenAI, OpenRouter or a local server to start chatting.
				</p>
			</div>
			<Button size="sm" onclick={openAdd}><PlusIcon class="size-4" />Add provider</Button>
		</div>
	{:else}
		<ul class="divide-y divide-border/60" aria-label="Providers">
			{#each data.providers as provider (provider.id)}
				{@const brand = resolveProviderBrand(provider)}
				<SettingsListItem title={provider.name} muted={!provider.enabled}>
					{#snippet leading()}
						{#if brand}<ProviderIcon {brand} class="size-4" />{:else}<PlugIcon
								class="size-4"
							/>{/if}
					{/snippet}
					{#snippet badges()}
						<Badge variant="outline">{typeLabels[provider.type]}</Badge>
					{/snippet}
					{#snippet meta()}
						<span title={provider.baseUrl ?? undefined}
							>{provider.baseUrl ?? 'Default endpoint'}</span
						>
						· {provider.hasApiKey ? 'API key set' : 'No API key'}
					{/snippet}
					{#snippet trailing()}
						<Button
							variant="ghost"
							size="sm"
							class="hidden sm:inline-flex"
							disabled={!provider.enabled}
							onclick={() => fetchModels(provider.id, provider.name)}
						>
							<DownloadIcon class="size-4" />
							Fetch models
						</Button>
						<Switch
							checked={provider.enabled}
							aria-label="Enable {provider.name}"
							onCheckedChange={(checked) => toggleEnabled(provider.id, checked)}
						/>
						<RowMenu
							label="Actions for {provider.name}"
							items={[
								{
									label: 'Fetch models',
									icon: DownloadIcon,
									disabled: !provider.enabled,
									onSelect: () => fetchModels(provider.id, provider.name)
								},
								{ label: 'Edit', icon: PencilIcon, onSelect: () => openEdit(provider) },
								'separator',
								{
									label: 'Delete',
									icon: Trash2Icon,
									destructive: true,
									onSelect: () => (deleteId = provider.id)
								}
							]}
						/>
					{/snippet}
				</SettingsListItem>
			{/each}
		</ul>
	{/if}
</SettingsSection>

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
