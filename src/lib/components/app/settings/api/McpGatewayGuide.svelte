<script lang="ts">
	import { resolve } from '$app/paths';
	import BlocksIcon from '@lucide/svelte/icons/blocks';
	import FileJsonIcon from '@lucide/svelte/icons/file-json';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import CodeBlock from '$lib/components/app/settings/CodeBlock.svelte';
	import CopyValue from '$lib/components/app/settings/CopyValue.svelte';
	import { BUILTIN_ICON } from '$lib/components/app/settings/mcp-builtins.js';
	import { formatTimeAgo } from '$lib/datetime.js';
	import { formatCount } from '$lib/formats.js';
	import { defaultAccess } from '$lib/mcp-access.js';
	import type { ApiKey, McpGatewayServer, McpGatewayUsage } from '$lib/types.js';
	import GuideStep from './GuideStep.svelte';
	import ScopeKeys from './ScopeKeys.svelte';
	import type { ApiScope } from './scopes.js';

	let {
		origin,
		keys,
		servers,
		usage,
		isAdmin,
		onCreateKey,
		onEditKey
	}: {
		origin: string;
		keys: ApiKey[];
		servers: McpGatewayServer[];
		usage: McpGatewayUsage;
		isAdmin: boolean;
		onCreateKey: (scope: ApiScope) => void;
		onEditKey: (key: ApiKey) => void;
	} = $props();

	const endpoint = $derived(`${origin}/api/mcp`);
	const gatewayKeys = $derived(keys.filter((k) => k.scopes.includes('mcp:use')));

	/** Per server id: the labels of the gateway keys that reach it. */
	const keysByServer = $derived.by(() => {
		// Rebuilt whole on every change, so a plain Map is fine.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const map = new Map<string, string[]>();
		for (const key of gatewayKeys) {
			for (const entry of key.mcpAccess ?? defaultAccess(servers)) {
				const label = entry.tools ? `${key.label} (some tools)` : key.label;
				map.set(entry.serverId, [...(map.get(entry.serverId) ?? []), label]);
			}
		}
		return map;
	});

	/** Servers some key reaches or that saw calls, busiest first. */
	const activeServers = $derived(
		servers
			.filter((s) => keysByServer.has(s.id) || usage.byServer[s.id]?.calls)
			.sort(
				(a, b) =>
					(usage.byServer[b.id]?.calls ?? 0) - (usage.byServer[a.id]?.calls ?? 0) ||
					a.name.localeCompare(b.name)
			)
	);

	function callsLine(server: McpGatewayServer): string {
		const totals = usage.byServer[server.id];
		if (!totals?.calls) return `No calls in the last ${usage.days} days`;
		const parts = [`${formatCount(totals.calls)} ${totals.calls === 1 ? 'call' : 'calls'}`];
		if (totals.errors) parts.push(`${formatCount(totals.errors)} failed`);
		parts.push(`last ${formatTimeAgo(totals.lastUsedAt)}`);
		const top = totals.topTools.map((t) => t.tool).join(', ');
		return `${parts.join(' · ')}${top ? ` — mostly ${top}` : ''}`;
	}

	const claudeCodeOAuthSnippet = $derived(
		`claude mcp add --scope user --transport http chatty ${endpoint}`
	);

	const claudeCodeKeySnippet = $derived(
		`claude mcp add --scope user --transport http chatty ${endpoint} \\
  --header "Authorization: Bearer aic_..."`
	);

	const mcpJsonSnippet = $derived(
		JSON.stringify(
			{
				mcpServers: {
					chatty: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer aic_...' } }
				}
			},
			null,
			2
		)
	);

	const opencodeSnippet = $derived(
		JSON.stringify(
			{
				$schema: 'https://opencode.ai/config.json',
				mcp: {
					chatty: { type: 'remote', url: endpoint, headers: { Authorization: 'Bearer aic_...' } }
				}
			},
			null,
			2
		)
	);

	const codexSnippet = $derived(
		`[mcp_servers.chatty]
url = "${endpoint}"
bearer_token_env_var = "CHATTY_API_KEY"`
	);

	const curlSnippet = $derived(
		`curl ${endpoint} \\
  -H "Authorization: Bearer aic_..." \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
	);
</script>

{#snippet code(text: string)}<code class="rounded bg-muted px-1 py-0.5 text-xs">{text}</code
	>{/snippet}

<ol class="flex flex-col">
	<GuideStep n={1} title="Choose how the client signs in">
		<div class="grid gap-2 sm:grid-cols-2">
			<div class="flex flex-col gap-1 rounded-xl border border-border/60 p-3">
				<span class="flex items-center gap-2 text-sm font-medium">
					<LogInIcon class="size-4 text-muted-foreground" aria-hidden="true" />Sign in with OAuth
				</span>
				<p class="text-xs text-muted-foreground">
					Claude Code and Claude.ai only need the endpoint. They open Chatty in your browser, where
					you approve them and pick their tools. Each approval shows up as a key.
				</p>
			</div>
			<div class="flex flex-col gap-1 rounded-xl border border-border/60 p-3">
				<span class="flex items-center gap-2 text-sm font-medium">
					<KeyRoundIcon class="size-4 text-muted-foreground" aria-hidden="true" />Use an API key
				</span>
				<p class="text-xs text-muted-foreground">
					For any other client: create a key with {@render code('mcp:use')} and pick its tools there.
				</p>
			</div>
		</div>
		<ScopeKeys scope="mcp:use" {keys} {onCreateKey} {onEditKey} />
		<p class="text-sm text-muted-foreground">
			Either way the tools act as you: your memory, chats and signed-in apps.
		</p>
	</GuideStep>
	<GuideStep n={2} title="Add the endpoint">
		<CopyValue label="Endpoint (Streamable HTTP)" value={endpoint} />
	</GuideStep>
	<GuideStep n={3} title="Connect a client" last={activeServers.length === 0}>
		<Tabs.Root value="claude-code" class="gap-3">
			<Tabs.List
				class="max-w-full [scrollbar-width:none] justify-start overflow-x-auto max-sm:[&_svg]:hidden"
			>
				<Tabs.Trigger value="claude-code">
					<ProviderIcon brand="claude" decorative />Claude Code
				</Tabs.Trigger>
				<Tabs.Trigger value="claude-ai">
					<ProviderIcon brand="claude" decorative />Claude.ai
				</Tabs.Trigger>
				<Tabs.Trigger value="json">
					<FileJsonIcon class="size-4" aria-hidden="true" />.mcp.json
				</Tabs.Trigger>
				<Tabs.Trigger value="codex">
					<ProviderIcon brand="openai" decorative />Codex
				</Tabs.Trigger>
				<Tabs.Trigger value="opencode">
					<ProviderIcon brand="opencode" decorative />OpenCode
				</Tabs.Trigger>
				<Tabs.Trigger value="curl">
					<SquareTerminalIcon class="size-4" aria-hidden="true" />curl
				</Tabs.Trigger>
			</Tabs.List>
			<Tabs.Content value="claude-code" class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">
					Adds Chatty for every project of this user. Then run {@render code('/mcp')} in Claude Code,
					pick {@render code('chatty')} and choose Authenticate: Chatty opens in your browser to approve
					it. For coding agents started through T3 Code, run this on the machine T3 Code runs on.
				</p>
				<CodeBlock code={claudeCodeOAuthSnippet} label="Shell · sign in with OAuth" />
				<p class="text-sm text-muted-foreground">Or skip the sign-in and pass an API key:</p>
				<CodeBlock code={claudeCodeKeySnippet} label="Shell · API key" />
			</Tabs.Content>
			<Tabs.Content value="claude-ai" class="flex flex-col gap-3">
				<ol class="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
					<li>In Claude, open Settings → Connectors and choose Add custom connector.</li>
					<li>Name it Chatty and paste the endpoint above as the URL.</li>
					<li>Choose Connect. Chatty opens so you can approve Claude and pick its tools.</li>
				</ol>
				<p class="text-xs text-muted-foreground">
					Claude.ai connects from Anthropic's servers, so Chatty must be reachable from the internet
					over HTTPS at this address.
				</p>
			</Tabs.Content>
			<Tabs.Content value="json" class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">
					For a project's {@render code('.mcp.json')} or any client that reads the same format. Keep the
					key out of version control.
				</p>
				<CodeBlock code={mcpJsonSnippet} label=".mcp.json" />
			</Tabs.Content>
			<Tabs.Content value="codex" class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">
					Add to {@render code('~/.codex/config.toml')} and set {@render code('CHATTY_API_KEY')} to the
					key.
				</p>
				<CodeBlock code={codexSnippet} label="config.toml" />
			</Tabs.Content>
			<Tabs.Content value="opencode" class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">
					Add this entry to your {@render code('opencode.json')}.
				</p>
				<CodeBlock code={opencodeSnippet} label="OpenCode config" />
			</Tabs.Content>
			<Tabs.Content value="curl" class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">List the tools a key gets.</p>
				<CodeBlock code={curlSnippet} label="curl" />
			</Tabs.Content>
		</Tabs.Root>
	</GuideStep>
	{#if activeServers.length > 0}
		<GuideStep n={4} title="See what gets used" last>
			<p class="text-sm text-muted-foreground">
				Servers your keys reach, over the last {usage.days} days.
				{#if isAdmin}
					Add or configure servers in <a
						class="underline underline-offset-4 hover:text-foreground"
						href={resolve('/settings/mcp')}>MCP servers</a
					>.
				{/if}
			</p>
			<ul class="divide-y divide-border/60 rounded-xl border border-border/60">
				{#each activeServers as server (server.id)}
					{@const Icon = (server.builtin && BUILTIN_ICON[server.name]) || BlocksIcon}
					<li class="flex items-start gap-3 px-3 py-2.5">
						<Icon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						<div class="flex min-w-0 flex-1 flex-col gap-0.5">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-sm font-medium">{server.name}</span>
								{#if server.needsSignIn}
									<a href={resolve('/settings/connections')}>
										<Badge variant="secondary" class="font-normal">Sign in to use</Badge>
									</a>
								{/if}
							</div>
							<p class="text-xs text-muted-foreground">
								{keysByServer.get(server.id)?.join(', ') ?? 'No key has access now'}
							</p>
							<p class="text-xs text-muted-foreground">{callsLine(server)}</p>
						</div>
					</li>
				{/each}
			</ul>
		</GuideStep>
	{/if}
</ol>
