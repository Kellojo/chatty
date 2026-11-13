<script lang="ts">
	import { resolve } from '$app/paths';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import CodeBlock from '$lib/components/app/settings/CodeBlock.svelte';
	import CopyValue from '$lib/components/app/settings/CopyValue.svelte';
	import type { ApiKey } from '$lib/types.js';
	import GuideStep from './GuideStep.svelte';
	import ScopeKeys from './ScopeKeys.svelte';
	import type { ApiScope } from './scopes.js';

	let {
		origin,
		keys,
		isAdmin,
		onCreateKey,
		onEditKey
	}: {
		origin: string;
		keys: ApiKey[];
		isAdmin: boolean;
		onCreateKey: (scope: ApiScope) => void;
		onEditKey: (key: ApiKey) => void;
	} = $props();

	const baseUrl = $derived(`${origin}/api/v1`);

	const curlSnippet = $derived(
		`curl ${baseUrl}/chat/completions \\
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
						options: { baseURL: baseUrl, apiKey: 'aic_...' },
						models: { '<model>': {} }
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
						baseUrl,
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

	const decisionsSnippet = $derived(
		`curl ${baseUrl}/decisions \\
  -H "Authorization: Bearer aic_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<model>","input":"I was charged twice for my order.","questions":[{"type":"choice","name":"department","instructions":"Which department should handle this complaint?","choices":[{"value":"billing","description":"Payments, invoices, and refunds."},{"value":"technical","description":"Problems using the product."},{"value":"shipping","description":"Delivery and tracking."},{"value":"other","description":"Requests outside these categories."}]}]}'`
	);
</script>

{#snippet code(text: string)}<code class="rounded bg-muted px-1 py-0.5 text-xs">{text}</code
	>{/snippet}

<ol class="flex flex-col">
	<GuideStep n={1} title="Get a key">
		<ScopeKeys scope="llm:invoke" {keys} {onCreateKey} {onEditKey} />
	</GuideStep>
	<GuideStep n={2} title="Point your tool at the base URL">
		<CopyValue label="Base URL (OpenAI-compatible)" value={baseUrl} />
		<p class="text-sm text-muted-foreground">
			Model ids come from {@render code(`GET ${baseUrl}/models`)}, which needs no key.
		</p>
	</GuideStep>
	<GuideStep n={3} title="Connect a client">
		<Tabs.Root value="curl" class="gap-3">
			<Tabs.List
				class="max-w-full [scrollbar-width:none] justify-start overflow-x-auto max-sm:[&_svg]:hidden"
			>
				<Tabs.Trigger value="curl">
					<SquareTerminalIcon class="size-4" aria-hidden="true" />curl
				</Tabs.Trigger>
				<Tabs.Trigger value="opencode">
					<ProviderIcon brand="opencode" decorative />OpenCode
				</Tabs.Trigger>
				<Tabs.Trigger value="pi">
					<ProviderIcon brand="pi" decorative />pi
				</Tabs.Trigger>
				<Tabs.Trigger value="claude-code">
					<ProviderIcon brand="claude" decorative />Claude Code
				</Tabs.Trigger>
			</Tabs.List>
			<Tabs.Content value="curl" class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">Stream a chat completion.</p>
				<CodeBlock code={curlSnippet} label="curl" />
			</Tabs.Content>
			<Tabs.Content value="opencode" class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">
					Add this provider entry to your {@render code('opencode.json')}.
				</p>
				<CodeBlock code={opencodeSnippet} label="OpenCode config" />
			</Tabs.Content>
			<Tabs.Content value="pi" class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">
					Add this provider to {@render code('models.json')} in pi's agent directory.
				</p>
				<CodeBlock code={piSnippet} label="pi config" />
			</Tabs.Content>
			<Tabs.Content value="claude-code" class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">
					Claude Code speaks the Anthropic Messages API. Point an OpenAI-compatible shim such as
					{@render code('claude-code-router')} at the base URL. Native {@render code(
						'/v1/messages'
					)}
					support is planned. To give Claude Code Chatty's tools instead, use the MCP gateway.
				</p>
			</Tabs.Content>
		</Tabs.Root>
	</GuideStep>
	<GuideStep n={4} title="Optional: classify and route with decisions" last>
		<p class="text-sm text-muted-foreground">
			Answer predicate, choice and score questions about an input in one call. Needs a model with
			the {@render code('decisions')} capability, set in
			{#if isAdmin}
				<a
					class="underline underline-offset-4 hover:text-foreground"
					href={resolve('/settings/defaults')}>Defaults</a
				>.
			{:else}
				Defaults by an admin.
			{/if}
		</p>
		<CodeBlock code={decisionsSnippet} label="curl" />
	</GuideStep>
</ol>
