<script lang="ts">
	import { resolve } from '$app/paths';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import CodeBlock from '$lib/components/app/settings/CodeBlock.svelte';
	import CopyValue from '$lib/components/app/settings/CopyValue.svelte';
	import type { ApiKey } from '$lib/types.js';
	import GuideStep from './GuideStep.svelte';
	import ScopeKeys from './ScopeKeys.svelte';
	import type { ApiScope } from './scopes.js';

	let {
		origin,
		keys,
		agents,
		onCreateKey,
		onEditKey
	}: {
		origin: string;
		keys: ApiKey[];
		/** The user's own agents: only those can be started with a key. */
		agents: { id: string; name: string }[];
		onCreateKey: (scope: ApiScope) => void;
		onEditKey: (key: ApiKey) => void;
	} = $props();

	let agentId = $state('');
	const agent = $derived(agents.find((a) => a.id === agentId) ?? agents[0]);
	const endpoint = $derived(`${origin}/api/agents/${agent?.id ?? '<agent-id>'}/run`);

	const curlSnippet = $derived(
		`curl -X POST ${endpoint} \\
  -H "Authorization: Bearer aic_..." \\
  -H "Content-Type: application/json" \\
  -d '{"instructions":"Optional extra instructions for this run"}'`
	);
</script>

{#snippet code(text: string)}<code class="rounded bg-muted px-1 py-0.5 text-xs">{text}</code
	>{/snippet}

<ol class="flex flex-col">
	<GuideStep n={1} title="Get a key">
		<ScopeKeys scope="agents:run" {keys} {onCreateKey} {onEditKey} />
	</GuideStep>
	<GuideStep n={2} title="Pick the agent">
		{#if agents.length === 0}
			<p class="text-sm text-muted-foreground">
				You have no agents of your own yet. <a
					class="underline underline-offset-4 hover:text-foreground"
					href={resolve('/agents/new')}>Create one</a
				> and its webhook URL shows up here.
			</p>
		{:else}
			<div class="flex flex-col gap-2 sm:max-w-sm">
				<Label for="webhook-agent">Agent</Label>
				<Select.Root type="single" bind:value={agentId}>
					<Select.Trigger id="webhook-agent" class="w-full">{agent?.name}</Select.Trigger>
					<Select.Content>
						{#each agents as option (option.id)}
							<Select.Item value={option.id}>{option.name}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
		{/if}
		<CopyValue label="Webhook URL (POST)" value={endpoint} />
	</GuideStep>
	<GuideStep n={3} title="Call it" last>
		<p class="text-sm text-muted-foreground">
			From cron, CI or any app that can send a request. The body is optional. Chatty answers
			{@render code('202 Accepted')} with the created run right away; the run continues in the background
			and shows up under the agent. Up to 20 runs a minute per key.
		</p>
		<CodeBlock code={curlSnippet} label="curl" />
	</GuideStep>
</ol>
