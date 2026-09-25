<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
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
					'ai-chat': {
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
		off: 'Disabled',
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

<div class="flex flex-col gap-4">
	<h2 class="text-xl font-semibold">API</h2>
	<p class="text-sm text-muted-foreground">
		Programmatic access: run agents over HTTP or call LLMs through the OpenAI-compatible proxy. API
		keys authenticate as you — treat them like passwords.
	</p>

	<Card.Root>
		<Card.Header>
			<Card.Title>API keys</Card.Title>
			<Card.Description>
				Used to trigger agents over HTTP and call the AI proxy. Treat keys like passwords.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Label</Table.Head>
						<Table.Head>Scopes</Table.Head>
						<Table.Head>Created</Table.Head>
						<Table.Head>Last used</Table.Head>
						<Table.Head class="text-right">Actions</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.apiKeys as key (key.id)}
						<Table.Row>
							<Table.Cell class="max-w-48 truncate font-medium" title={key.label}>
								{key.label}
							</Table.Cell>
							<Table.Cell>
								<div class="flex flex-wrap gap-1">
									{#each key.scopes as scope (scope)}
										<Badge variant="secondary">{scope}</Badge>
									{/each}
								</div>
							</Table.Cell>
							<Table.Cell class="whitespace-nowrap text-muted-foreground">
								{formatDateTime(key.createdAt, data.timeFormat)}
							</Table.Cell>
							<Table.Cell class="whitespace-nowrap text-muted-foreground">
								{key.lastUsedAt ? formatDateTime(key.lastUsedAt, data.timeFormat) : 'never'}
							</Table.Cell>
							<Table.Cell class="text-right">
								<Button
									variant="destructive"
									size="sm"
									disabled={deleteKeyBusy !== null}
									onclick={() => deleteKey(key.id)}
								>
									{deleteKeyBusy === key.id ? 'Deleting…' : 'Delete'}
								</Button>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row>
							<Table.Cell colspan={5} class="text-center text-muted-foreground">
								No API keys yet.
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			<div>
				<Button onclick={openKeyDialog}>Create API key</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<h3 class="text-lg font-semibold">Agent API</h3>
	<p class="text-sm text-muted-foreground">
		Trigger agents over HTTP. Requires an API key with the
		<code class="rounded bg-muted px-1 py-0.5 text-xs">agents:run</code> scope.
	</p>

	<Card.Root>
		<Card.Header>
			<Card.Title>curl</Card.Title>
			<Card.Description>
				Start an agent run. The request returns <code class="rounded bg-muted px-1 py-0.5 text-xs"
					>202 Accepted</code
				> with the created run.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs">{agentRunSnippet}</pre>
			<div>
				<Button
					variant="outline"
					size="sm"
					onclick={() => copyText('agent-run', agentRunSnippet)}
					aria-label="Copy agent run snippet"
				>
					{#if copiedId === 'agent-run'}
						<CheckIcon class="size-4" />
					{:else}
						<CopyIcon class="size-4" />
					{/if}
					Copy
				</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<h3 class="text-lg font-semibold">Model inference</h3>
	<p class="text-sm text-muted-foreground">
		<code class="rounded bg-muted px-1 py-0.5 text-xs">GET {origin}/api/v1/models</code> lists
		available model ids (no auth). Inference calls require an API key with the
		<code class="rounded bg-muted px-1 py-0.5 text-xs">llm:invoke</code> scope.
	</p>

	<Card.Root>
		<Card.Header>
			<Card.Title>curl</Card.Title>
			<Card.Description>
				Call the chat completions endpoint with an API key that has the
				<code class="rounded bg-muted px-1 py-0.5 text-xs">llm:invoke</code> scope.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs">{curlSnippet}</pre>
			<div>
				<Button
					variant="outline"
					size="sm"
					onclick={() => copyText('curl', curlSnippet)}
					aria-label="Copy curl snippet"
				>
					{#if copiedId === 'curl'}
						<CheckIcon class="size-4" />
					{:else}
						<CopyIcon class="size-4" />
					{/if}
					Copy
				</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>opencode</Card.Title>
			<Card.Description>
				Add this provider entry to your <code class="rounded bg-muted px-1 py-0.5 text-xs"
					>opencode.json</code
				>.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs">{opencodeSnippet}</pre>
			<div>
				<Button
					variant="outline"
					size="sm"
					onclick={() => copyText('opencode', opencodeSnippet)}
					aria-label="Copy opencode config"
				>
					{#if copiedId === 'opencode'}
						<CheckIcon class="size-4" />
					{:else}
						<CopyIcon class="size-4" />
					{/if}
					Copy
				</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Claude Code</Card.Title>
		</Card.Header>
		<Card.Content>
			<p class="text-sm text-muted-foreground">
				Claude Code speaks the Anthropic Messages API. Point an OpenAI-compatible shim such as
				<code class="rounded bg-muted px-1 py-0.5 text-xs">claude-code-router</code> at
				<code class="rounded bg-muted px-1 py-0.5 text-xs">{origin}/api/v1</code> with an
				<code class="rounded bg-muted px-1 py-0.5 text-xs">llm:invoke</code> key. Native
				<code class="rounded bg-muted px-1 py-0.5 text-xs">/v1/messages</code> support is planned.
			</p>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Compression</Card.Title>
			<Card.Description>
				Reduce token usage for requests made through the AI proxy with your API keys.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<div class="flex items-center justify-between gap-6">
				<div class="flex min-w-0 flex-col gap-1">
					<Label>Caveman</Label>
					<p class="text-sm text-muted-foreground">
						{cavemanDescriptions[caveman]}
					</p>
					<p class="text-xs text-muted-foreground">
						Savings are estimates; the prompt adds ~1–1.5k input tokens overhead per request.
					</p>
				</div>
				<Select.Root
					type="single"
					value={caveman}
					onValueChange={(value) => changeCaveman(value as CavemanLevel)}
				>
					<Select.Trigger class="w-48 shrink-0" disabled={cavemanBusy}>
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
			</div>
			<div class="flex flex-col gap-2 border-t pt-4">
				<Label>Your savings</Label>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
					<dt class="text-muted-foreground">Proxy requests</dt>
					<dd>{data.savings.total.toLocaleString()}</dd>
					<dt class="text-muted-foreground">Caveman saved (est.)</dt>
					<dd>{data.savings.cavemanSaved.toLocaleString()} tokens</dd>
				</dl>
			</div>
		</Card.Content>
	</Card.Root>
</div>

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
