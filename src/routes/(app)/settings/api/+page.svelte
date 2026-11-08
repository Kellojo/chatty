<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import CodeIcon from '@lucide/svelte/icons/code';
	import BotIcon from '@lucide/svelte/icons/bot';
	import SquarePiIcon from '@lucide/svelte/icons/square-pi';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import CodeBlock from '$lib/components/app/settings/CodeBlock.svelte';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { formatDateTime } from '$lib/datetime.js';
	import type { ApiKey } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const origin = $derived(page.url.origin);

	const agentRunSnippet = $derived(
		`curl -X POST ${origin}/api/agents/<agent-id>/run \\
  -H "Authorization: Bearer aic_..." \\
  -H "Content-Type: application/json" \\
  -d '{"instructions":"Optional extra instructions for this run"}'`
	);

	const curlSnippet = $derived(
		`curl ${origin}/api/v1/chat/completions \\
  -H "Authorization: Bearer aic_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<model>","messages":[{"role":"user","content":"Hello"}],"stream":true}'`
	);

	const opencodeSnippet = $derived(
		JSON.stringify(
			{
				$schema: 'https://opencode.ai/config.json',
				provider: {
					chatty: {
						npm: '@ai-sdk/openai-compatible',
						options: {
							baseURL: `${origin}/api/v1`,
							apiKey: 'aic_...'
						},
						models: {
							'<model>': {}
						}
					}
				}
			},
			null,
			2
		)
	);

	const piSnippet = $derived(
		JSON.stringify(
			{
				providers: {
					chatty: {
						baseUrl: `${origin}/api/v1`,
						api: 'openai-completions',
						apiKey: 'aic_...',
						models: [{ id: '<model>' }]
					}
				}
			},
			null,
			2
		)
	);

	const decisionsCurlSnippet = $derived(
		`curl ${origin}/api/v1/decisions \\
  -H "Authorization: Bearer aic_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<model>","input":"I was charged twice for my order.","questions":[{"type":"choice","name":"department","instructions":"Which department should handle this complaint?","choices":[{"value":"billing","description":"Payments, invoices, and refunds."},{"value":"technical","description":"Problems using the product."},{"value":"shipping","description":"Delivery and tracking."},{"value":"other","description":"Requests outside these categories."}]}]}'`
	);

	let keyDialogOpen = $state(false);
	let keyLabel = $state('');
	let scopeAgentsRun = $state(false);
	let scopeLlmInvoke = $state(true);
	let keyBusy = $state(false);
	let createdKey = $state<string | null>(null);
	let deleteKeyBusy = $state<string | null>(null);
	let deleteKeyId = $state<string | null>(null);

	type CavemanLevel = 'off' | 'lite' | 'full' | 'ultra' | 'wenyan';

	const cavemanLevels: CavemanLevel[] = ['off', 'lite', 'full', 'ultra', 'wenyan'];

	const cavemanLabels: Record<CavemanLevel, string> = {
		off: 'Off',
		lite: 'Lite',
		full: 'Full',
		ultra: 'Ultra',
		wenyan: 'Wenyan (文言文)'
	};

	const cavemanDescriptions: Record<CavemanLevel, string> = {
		off: 'Responses come back exactly as the model writes them.',
		lite: 'Tight professional prose, no filler (small savings)',
		full: 'Classic caveman: drops articles, fragments (~65% fewer output tokens, estimated)',
		ultra: 'Maximum English terseness (largest English savings, estimated)',
		wenyan: 'Classical Chinese (文言文) terseness, 80–90% character reduction, estimated'
	};

	let caveman = $state<CavemanLevel>(data.proxySettings.caveman);
	let cavemanBusy = $state(false);

	const selectedScopes = $derived(
		[
			scopeAgentsRun ? ('agents:run' as const) : null,
			scopeLlmInvoke ? ('llm:invoke' as const) : null
		].filter((scope) => scope !== null)
	);

	let copiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	async function copyText(id: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied');
			copiedId = id;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				copiedId = null;
			}, 2000);
		} catch {
			toast.error('Failed to copy');
		}
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

	function openKeyDialog() {
		keyLabel = '';
		scopeAgentsRun = false;
		scopeLlmInvoke = true;
		createdKey = null;
		keyDialogOpen = true;
	}

	function closeKeyDialog(open: boolean) {
		keyDialogOpen = open;
		if (!open && createdKey) {
			createdKey = null;
			invalidateAll();
		}
	}

	async function createKey(event: SubmitEvent) {
		event.preventDefault();
		if (keyBusy || selectedScopes.length === 0) return;
		keyBusy = true;
		try {
			const res = await api('/api/api-keys', 'POST', {
				label: keyLabel.trim(),
				scopes: selectedScopes
			});
			const payload = (await res.json()) as { key: ApiKey & { rawKey: string } };
			createdKey = payload.key.rawKey;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to create API key');
		} finally {
			keyBusy = false;
		}
	}

	async function deleteKey(id: string) {
		deleteKeyId = id;
	}

	async function confirmDeleteKey() {
		if (!deleteKeyId || deleteKeyBusy) return;
		deleteKeyBusy = deleteKeyId;
		try {
			await api(`/api/api-keys/${deleteKeyId}`, 'DELETE');
			toast.success('API key deleted');
			deleteKeyId = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete API key');
		} finally {
			deleteKeyBusy = null;
		}
	}

	async function changeCaveman(value: CavemanLevel) {
		if (cavemanBusy || value === caveman) return;
		const previous = caveman;
		caveman = value;
		cavemanBusy = true;
		try {
			await api('/api/proxy-settings', 'POST', { caveman: value });
		} catch (e) {
			caveman = previous;
			toast.error(e instanceof Error ? e.message : 'Failed to update Caveman level');
		} finally {
			cavemanBusy = false;
		}
	}
</script>

<svelte:head><title>API · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="API"
	description="Run agents over HTTP or call models through the OpenAI-compatible proxy. API keys act as you, so treat them like passwords."
>
	{#snippet actions()}
		<Button onclick={openKeyDialog}><PlusIcon class="size-4" />Create key</Button>
	{/snippet}
</SettingsHeader>

<SettingsSection title="API keys" flush>
	{#snippet description()}
		Scope a key to <code class="rounded bg-muted px-1 py-0.5 text-xs">agents:run</code>,
		<code class="rounded bg-muted px-1 py-0.5 text-xs">llm:invoke</code> or both.
	{/snippet}
	{#if data.apiKeys.length === 0}
		<div
			class="flex flex-col items-center gap-3 border-t border-border/60 px-6 pt-6 pb-4 text-center"
		>
			<div
				class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
			>
				<KeyRoundIcon class="size-5" />
			</div>
			<div class="flex flex-col gap-1">
				<p class="text-sm font-medium">No API keys yet</p>
				<p class="text-sm text-muted-foreground">
					Create one to start agent runs or call models from scripts and other tools.
				</p>
			</div>
		</div>
	{:else}
		<ul class="divide-y divide-border/60 border-t border-border/60" aria-label="API keys">
			{#each data.apiKeys as key (key.id)}
				<SettingsListItem title={key.label}>
					{#snippet leading()}<KeyRoundIcon class="size-4" />{/snippet}
					{#snippet badges()}
						{#each key.scopes as scope (scope)}
							<Badge variant="secondary" class="font-mono font-normal">{scope}</Badge>
						{/each}
					{/snippet}
					{#snippet meta()}
						Created {formatDateTime(key.createdAt, data.timeFormat)} · {key.lastUsedAt
							? `Last used ${formatDateTime(key.lastUsedAt, data.timeFormat)}`
							: 'Never used'}
					{/snippet}
					{#snippet trailing()}
						<Button
							variant="ghost"
							size="icon-sm"
							class="text-muted-foreground hover:text-destructive"
							title="Delete key"
							aria-label="Delete key {key.label}"
							disabled={deleteKeyBusy !== null}
							onclick={() => deleteKey(key.id)}
						>
							<Trash2Icon class="size-4" />
						</Button>
					{/snippet}
				</SettingsListItem>
			{/each}
		</ul>
	{/if}
</SettingsSection>

<SettingsSection title="Agent API">
	{#snippet description()}
		Start an agent run. Needs a key with the <code class="rounded bg-muted px-1 py-0.5 text-xs"
			>agents:run</code
		>
		scope and returns
		<code class="rounded bg-muted px-1 py-0.5 text-xs">202 Accepted</code> with the created run.
	{/snippet}
	<CodeBlock code={agentRunSnippet} label="curl" />
</SettingsSection>

<SettingsSection title="Model inference">
	{#snippet description()}
		Point your tools at the OpenAI-compatible proxy with an <code
			class="rounded bg-muted px-1 py-0.5 text-xs">llm:invoke</code
		>
		key. Listing model ids needs no key:
		<code
			class="inline-block max-w-full overflow-x-auto rounded bg-muted px-1 py-0.5 align-bottom text-xs whitespace-nowrap"
			>GET {origin}/api/v1/models</code
		>
	{/snippet}
	<Tabs.Root value="curl" class="gap-3">
		<Tabs.List
			class="max-w-full [scrollbar-width:none] justify-start overflow-x-auto max-sm:[&_svg]:hidden"
		>
			<Tabs.Trigger value="curl">
				<SquareTerminalIcon class="size-4" aria-hidden="true" />curl
			</Tabs.Trigger>
			<Tabs.Trigger value="opencode">
				<CodeIcon class="size-4" aria-hidden="true" />OpenCode
			</Tabs.Trigger>
			<Tabs.Trigger value="claude-code">
				<BotIcon class="size-4" aria-hidden="true" />Claude Code
			</Tabs.Trigger>
			<Tabs.Trigger value="pi">
				<SquarePiIcon class="size-4" aria-hidden="true" />pi
			</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="curl" class="flex flex-col gap-3">
			<p class="text-sm text-muted-foreground">Stream a chat completion.</p>
			<CodeBlock code={curlSnippet} label="curl" />
		</Tabs.Content>
		<Tabs.Content value="opencode" class="flex flex-col gap-3">
			<p class="text-sm text-muted-foreground">
				Add this provider entry to your <code class="rounded bg-muted px-1 py-0.5 text-xs"
					>opencode.json</code
				>.
			</p>
			<CodeBlock code={opencodeSnippet} label="OpenCode config" />
		</Tabs.Content>
		<Tabs.Content value="claude-code" class="flex flex-col gap-3">
			<p class="text-sm text-muted-foreground">
				Claude Code speaks the Anthropic Messages API. Point an OpenAI-compatible shim such as
				<code class="rounded bg-muted px-1 py-0.5 text-xs">claude-code-router</code> at
				<code class="rounded bg-muted px-1 py-0.5 text-xs">{origin}/api/v1</code>
				with an
				<code class="rounded bg-muted px-1 py-0.5 text-xs">llm:invoke</code> key. Native
				<code class="rounded bg-muted px-1 py-0.5 text-xs">/v1/messages</code> support is planned.
			</p>
		</Tabs.Content>
		<Tabs.Content value="pi" class="flex flex-col gap-3">
			<p class="text-sm text-muted-foreground">
				Add this provider to <code class="rounded bg-muted px-1 py-0.5 text-xs">models.json</code>
				in pi's agent directory and replace
				<code class="rounded bg-muted px-1 py-0.5 text-xs">&lt;model&gt;</code> with a model id from the
				models endpoint.
			</p>
			<CodeBlock code={piSnippet} label="pi config" />
		</Tabs.Content>
	</Tabs.Root>
</SettingsSection>

<SettingsSection title="Decisions">
	{#snippet description()}
		Classify content, route requests and score inputs with predicate, choice and score questions.
		Needs an <code class="rounded bg-muted px-1 py-0.5 text-xs">llm:invoke</code> key and a model
		with the
		<code class="rounded bg-muted px-1 py-0.5 text-xs">decisions</code> capability set in
		{#if data.user.role === 'admin'}
			<a
				class="underline underline-offset-4 hover:text-foreground"
				href={resolve('/settings/defaults')}>Defaults</a
			>; until then the endpoint returns an error.
		{:else}
			Defaults by an admin; until then the endpoint returns an error.
		{/if}
	{/snippet}
	<CodeBlock code={decisionsCurlSnippet} label="curl" />
</SettingsSection>

<SettingsSection
	title="Compression"
	description="Reduce token usage for proxy requests made with your API keys."
>
	<SettingsRow label="Caveman" for="caveman-level" stack>
		{#snippet description()}
			<p>{cavemanDescriptions[caveman]}</p>
			<p class="mt-1 text-xs">
				Savings are estimates; the prompt adds about 1–1.5k input tokens per request.
			</p>
		{/snippet}
		<Select.Root
			type="single"
			value={caveman}
			onValueChange={(value) => changeCaveman(value as CavemanLevel)}
		>
			<Select.Trigger id="caveman-level" class="w-full sm:w-48" disabled={cavemanBusy}>
				{cavemanLabels[caveman]}
			</Select.Trigger>
			<Select.Content>
				{#each cavemanLevels as option (option)}
					<Select.Item value={option}>
						<span class="flex flex-col">
							<span>{cavemanLabels[option]}</span>
							<span class="text-xs whitespace-normal text-muted-foreground">
								{cavemanDescriptions[option]}
							</span>
						</span>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</SettingsRow>
	<dl class="grid grid-cols-2 gap-3 border-t pt-4">
		<div class="flex flex-col gap-0.5 rounded-xl bg-muted/50 px-4 py-3">
			<dt class="text-xs text-muted-foreground">Proxy requests</dt>
			<dd class="text-xl font-semibold tabular-nums">{data.savings.total.toLocaleString()}</dd>
		</div>
		<div class="flex flex-col gap-0.5 rounded-xl bg-muted/50 px-4 py-3">
			<dt class="text-xs text-muted-foreground">Tokens saved (est.)</dt>
			<dd class="text-xl font-semibold tabular-nums">
				{data.savings.cavemanSaved.toLocaleString()}
			</dd>
		</div>
	</dl>
</SettingsSection>

<Dialog.Root open={keyDialogOpen} onOpenChange={closeKeyDialog}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Create API key</Dialog.Title>
		</Dialog.Header>
		{#if createdKey}
			<div class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">Shown once — store it now.</p>
				<div class="flex items-center gap-2">
					<Input value={createdKey} readonly class="font-mono text-xs" />
					<Button
						variant="outline"
						size="sm"
						onclick={() => copyText('raw-key', createdKey ?? '')}
						aria-label="Copy API key"
					>
						{#if copiedId === 'raw-key'}
							<CheckIcon class="size-4" />
						{:else}
							<CopyIcon class="size-4" />
						{/if}
					</Button>
				</div>
				<Dialog.Footer>
					<Button onclick={() => closeKeyDialog(false)}>Done</Button>
				</Dialog.Footer>
			</div>
		{:else}
			<form onsubmit={createKey} class="flex flex-col gap-4">
				<div class="flex flex-col gap-2">
					<Label for="api-key-label">Label</Label>
					<Input
						id="api-key-label"
						bind:value={keyLabel}
						maxlength={100}
						required
						placeholder="e.g. Nightly automation"
					/>
				</div>
				<div class="flex flex-col gap-3">
					<Label>Scopes</Label>
					<div class="flex items-center justify-between gap-6">
						<div class="flex min-w-0 flex-col gap-1">
							<Label for="scope-agents-run" class="font-normal">agents:run</Label>
							<p class="text-sm text-muted-foreground">Trigger agents over HTTP.</p>
						</div>
						<Switch id="scope-agents-run" bind:checked={scopeAgentsRun} />
					</div>
					<div class="flex items-center justify-between gap-6">
						<div class="flex min-w-0 flex-col gap-1">
							<Label for="scope-llm-invoke" class="font-normal">llm:invoke</Label>
							<p class="text-sm text-muted-foreground">Call the AI proxy (LLM API).</p>
						</div>
						<Switch id="scope-llm-invoke" bind:checked={scopeLlmInvoke} />
					</div>
				</div>
				<Dialog.Footer>
					<Button
						type="submit"
						disabled={keyBusy || !keyLabel.trim() || selectedScopes.length === 0}
					>
						{keyBusy ? 'Creating…' : 'Create key'}
					</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteKeyId !== null} onOpenChange={(open) => !open && (deleteKeyId = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete API key?</Dialog.Title>
			<Dialog.Description>
				Any service using this key will immediately lose access. This cannot be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteKeyId = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteKeyBusy !== null} onclick={confirmDeleteKey}>
				{deleteKeyBusy === deleteKeyId ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
