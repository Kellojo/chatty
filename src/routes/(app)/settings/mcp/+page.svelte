<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import McpUsageStats from '$lib/components/app/settings/McpUsageStats.svelte';
	import { DEFAULT_USAGE_PERIOD, type UsagePeriod } from '$lib/components/app/usage/usage.js';
	import McpUsageDialog from '$lib/components/app/settings/McpUsageDialog.svelte';
	import McpTestDialog, {
		type McpTestResult
	} from '$lib/components/app/settings/McpTestDialog.svelte';
	import { fadeWhenScrollable } from '$lib/fade-when-scrollable.js';
	import { toast } from 'svelte-sonner';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { resolve } from '$app/paths';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CopyButton from '$lib/components/app/settings/CopyValue.svelte';
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
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import { formatTimeAgo } from '$lib/datetime.js';
	import type { McpServerInfo, McpServerUsageDetail } from '$lib/types.js';
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
		const usage: RowMenuItem = {
			label: 'View usage',
			icon: ChartColumnIcon,
			onSelect: () => openUsage(server)
		};
		if (server.builtin) return [usage, test, loadMode];
		return [
			{ label: 'Edit', icon: PencilIcon, onSelect: () => openEdit(server) },
			usage,
			test,
			loadMode,
			'separator',
			{ label: 'Delete', icon: Trash2Icon, destructive: true, onSelect: () => openDelete(server) }
		];
	}

	type ConfigurableTransport = 'http' | 'sse' | 'stdio';
	const transportLabels: Record<ConfigurableTransport, string> = {
		http: 'HTTP',
		sse: 'SSE',
		stdio: 'stdio (local command)'
	};

	type AuthMode = 'token' | 'oauth';
	/** Authentication settings of a remote (http/sse) server form. */
	interface AuthForm {
		mode: AuthMode;
		token: string;
		clientId: string;
		clientSecret: string;
		scope: string;
		/** Use a client registered by hand (the disclosure is open) instead of automatic registration. */
		manual: boolean;
	}
	const emptyAuth = (): AuthForm => ({
		mode: 'token',
		token: '',
		clientId: '',
		clientSecret: '',
		scope: '',
		manual: false
	});
	const authLabels: Record<AuthMode, string> = {
		token: 'Token (or none)',
		oauth: 'OAuth (each user signs in)'
	};

	let addAuth = $state<AuthForm>(emptyAuth());
	let editAuth = $state<AuthForm>(emptyAuth());

	/** Request fields for a form's authentication; `editing` keeps stored secrets left empty. */
	function authBody(form: AuthForm, editing: boolean): Record<string, unknown> {
		if (form.mode === 'token') {
			return {
				auth: 'token',
				...(editing ? (form.token ? { token: form.token } : {}) : { token: form.token || null })
			};
		}
		// A closed disclosure means automatic registration: drop any hand-registered client.
		if (!form.manual) {
			return {
				auth: 'oauth',
				token: null,
				oauthClientId: null,
				oauthClientSecret: null,
				oauthScope: null
			};
		}
		return {
			auth: 'oauth',
			token: null,
			oauthClientId: form.clientId.trim() || null,
			oauthScope: form.scope.trim() || null,
			...(form.clientSecret
				? { oauthClientSecret: form.clientSecret }
				: editing
					? {}
					: { oauthClientSecret: null })
		};
	}

	let addOpen = $state(false);
	let addName = $state('');
	let addTransport = $state<ConfigurableTransport>('http');
	let addUrl = $state('');
	let addCommand = $state('');
	let addArgs = $state('');
	let addBusy = $state(false);

	let editOpen = $state(false);
	let editId = $state<string | null>(null);
	let editName = $state('');
	let editTransport = $state<ConfigurableTransport>('http');
	let editUrl = $state('');
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
	let testServer = $state<McpServerInfo | null>(null);
	let testResult = $state<McpTestResult | null>(null);

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
		addAuth = emptyAuth();
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
				...(addTransport === 'stdio' ? {} : authBody(addAuth, false))
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
		editAuth = {
			mode: server.auth,
			token: '',
			clientId: server.oauthClientId ?? '',
			clientSecret: '',
			scope: server.oauthScope ?? '',
			manual: !!server.oauthClientId
		};
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
				...(editTransport === 'stdio' ? {} : authBody(editAuth, true))
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

	/** Resolves to whether the change was saved (failures are toasted here). */
	async function toggleEnabled(server: McpServerInfo, enabled: boolean): Promise<boolean> {
		enabledOverride[server.id] = enabled;
		try {
			await api(`/api/mcp-servers/${server.id}`, 'PATCH', { enabled });
			await invalidateAll();
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update server');
			return false;
		} finally {
			delete enabledOverride[server.id];
		}
	}

	async function disableFromUsage(server: McpServerInfo): Promise<boolean> {
		const ok = await toggleEnabled(server, false);
		if (ok) {
			toast.success(`${server.name} turned off`, {
				action: { label: 'Undo', onClick: () => void toggleEnabled(server, true) }
			});
		}
		return ok;
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
		// Open at once with a loading state; a retest keeps the last result until the new one lands.
		if (testServer?.id !== server.id || !testOpen) testResult = null;
		testServer = server;
		testOpen = true;
		let result: McpTestResult;
		try {
			const res = await api(`/api/mcp-servers/${server.id}/test`, 'POST');
			result = (await res.json()) as McpTestResult;
		} catch (e) {
			result = {
				ok: false,
				tools: [],
				error: e instanceof Error ? e.message : 'Connection test failed'
			};
		} finally {
			if (testBusyId === server.id) testBusyId = null;
		}
		// A test of another server started meanwhile owns the dialog now.
		if (testServer?.id !== server.id) return;
		testResult = result;
		// The test records the server's tool count.
		if (result.ok) void invalidateAll();
	}

	let usageOpen = $state(false);
	let usageServer = $state<McpServerInfo | null>(null);
	let usageDetail = $state<McpServerUsageDetail | null>(null);

	async function openUsage(server: McpServerInfo) {
		usageServer = server;
		usageDetail = null;
		usageOpen = true;
		try {
			const res = await api(`/api/mcp-servers/${server.id}/usage`, 'GET');
			const detail = (await res.json()) as McpServerUsageDetail;
			// Ignore a late answer for a server whose usage is no longer shown.
			if (usageServer?.id === server.id) usageDetail = detail;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not load usage');
			usageOpen = false;
		}
	}

	/** The usage line under a server: how much it was used, or that it sat idle. */
	function usageLabel(server: McpServerInfo): string {
		const usage = data.usage[server.id];
		const window = `${data.usageWindowDays} days`;
		if (!usage || usage.calls === 0) {
			const last = usage?.lastUsedAt ? ` · last used ${formatTimeAgo(usage.lastUsedAt)}` : '';
			return `Not used in the last ${window}${last}`;
		}
		const parts = [
			`${plural(usage.calls, 'call')} in ${window}`,
			plural(usage.users, 'user'),
			...(usage.errors > 0 ? [`${failureRate(usage.calls, usage.errors)} failed`] : [])
		];
		if (usage.lastUsedAt) parts.push(`last used ${formatTimeAgo(usage.lastUsedAt)}`);
		return parts.join(' · ');
	}

	function isUnused(server: McpServerInfo): boolean {
		return !data.usage[server.id]?.calls;
	}

	const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
	const failureRate = (calls: number, errors: number) =>
		`${Math.max(1, Math.round((errors / calls) * 100))}%`;

	type Tab = 'servers' | 'statistics';
	// The tab and the statistics period live in the URL, so a reload or a shared link keeps them.
	const activeTab = $derived<Tab>(
		page.url.searchParams.get('tab') === 'statistics' ? 'statistics' : 'servers'
	);

	/** This page with `updates` applied to its query (empty values drop the param). */
	function navigate(updates: { tab?: Tab; period?: UsagePeriod }) {
		// A throwaway copy for building one href, not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams(page.url.searchParams);
		if (updates.tab) params.set('tab', updates.tab);
		if (updates.period) params.set('period', updates.period);
		if (params.get('tab') === 'servers') params.delete('tab');
		if (params.get('period') === DEFAULT_USAGE_PERIOD) params.delete('period');
		const qs = params.toString();
		// The resolved path of this page plus its own query.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(`${resolve('/settings/mcp')}${qs ? `?${qs}` : ''}`, {
			keepFocus: true,
			noScroll: true,
			replaceState: true
		});
	}

	function selectTab(value: string) {
		navigate({ tab: value === 'statistics' ? 'statistics' : 'servers' });
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
	description="Tools from Model Context Protocol servers, available in chats and agent runs."
>
	{#snippet actions()}
		<Button onclick={openAdd}><PlusIcon class="size-4" />Add server</Button>
	{/snippet}
</SettingsHeader>

{#snippet authFields(form: AuthForm, id: string, editing: boolean)}
	{@const server = editing ? data.servers.find((s) => s.id === editId) : undefined}
	<div class="flex min-w-0 flex-col gap-2">
		<Label for="{id}-auth">Authentication</Label>
		<Select.Root type="single" bind:value={form.mode}>
			<Select.Trigger id="{id}-auth" class="w-full">{authLabels[form.mode]}</Select.Trigger>
			<Select.Content>
				<Select.Item value="token">{authLabels.token}</Select.Item>
				<Select.Item value="oauth">{authLabels.oauth}</Select.Item>
			</Select.Content>
		</Select.Root>
		{#if form.mode === 'oauth'}
			<p class="text-xs text-muted-foreground">
				Each user connects their own account under
				<a class="underline underline-offset-2" href={resolve('/settings/connections')}
					>Connected apps</a
				>.
			</p>
		{/if}
	</div>
	{#if form.mode === 'token'}
		<div class="flex flex-col gap-2">
			<Label for="{id}-token">Token{editing ? '' : ' (optional)'}</Label>
			<Input
				id="{id}-token"
				type="password"
				bind:value={form.token}
				autocomplete="off"
				placeholder={editing && server?.hasToken
					? 'Leave empty to keep the current token'
					: 'Sent as a Bearer token'}
			/>
		</div>
	{:else}
		{#if !form.manual}
			<div class="flex min-w-0 flex-col gap-3 rounded-2xl border p-4 text-xs">
				<div class="flex flex-col gap-0.5">
					<p class="text-sm font-medium text-foreground">Registering Chatty with your provider</p>
					<p class="text-muted-foreground">
						Most providers need nothing. Otherwise, add Chatty with these values.
					</p>
				</div>
				<CopyButton label="Chatty’s client ID" value={data.oauth.clientMetadataUrl} />
				<CopyButton label="Redirect URL" value={data.oauth.redirectUrl} />
			</div>
		{/if}
		<details class="group min-w-0" bind:open={form.manual}>
			<summary
				class="flex w-fit cursor-pointer list-none items-start gap-1.5 rounded-md py-1 text-sm font-medium text-foreground/80 outline-none group-open:text-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
			>
				<ChevronRightIcon
					class="mt-0.5 size-4 shrink-0 transition-transform group-open:rotate-90"
				/>
				<span class="flex flex-col gap-0.5">
					Use a client registered by hand
					<!-- Only the summary of a closed <details> shows, so the hint lives in here. -->
					<span class="text-xs font-normal text-muted-foreground group-open:hidden">
						For providers that don’t support automatic registration
					</span>
				</span>
			</summary>
			<div class="mt-3 flex flex-col gap-4">
				<div class="flex min-w-0 flex-col gap-3 rounded-2xl border p-4 text-xs">
					<p class="text-muted-foreground">
						Register Chatty with your provider using this redirect URL.
					</p>
					<CopyButton label="Redirect URL" value={data.oauth.redirectUrl} />
				</div>
				<div class="flex flex-col gap-2">
					<Label for="{id}-client-id">Client ID from your provider</Label>
					<Input
						id="{id}-client-id"
						bind:value={form.clientId}
						autocomplete="off"
						required={form.manual}
						placeholder="From your provider’s app registration"
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="{id}-client-secret">Client secret (optional)</Label>
					<Input
						id="{id}-client-secret"
						type="password"
						bind:value={form.clientSecret}
						autocomplete="off"
						placeholder={editing && server?.hasOauthClientSecret
							? 'Leave empty to keep the current secret'
							: 'Only for confidential clients'}
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="{id}-scope">Scopes (optional)</Label>
					<Input
						id="{id}-scope"
						bind:value={form.scope}
						autocomplete="off"
						placeholder="Default: what the server advertises"
					/>
				</div>
			</div>
		</details>
	{/if}
{/snippet}

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
			{#if server.toolCount}
				<Badge
					variant="outline"
					class="text-muted-foreground tabular-nums"
					title="Tools listed the last time Chatty connected"
				>
					{plural(server.toolCount, 'tool')}
				</Badge>
			{/if}
			{#if !server.builtin && server.transport !== 'builtin'}
				<Badge variant="outline">{transportLabels[server.transport]}</Badge>
			{/if}
			{#if server.auth === 'oauth'}
				<Badge variant="secondary" title="Each user signs in under Settings → Connected apps">
					OAuth
				</Badge>
			{/if}
			{#if enabled && isUnused(server)}
				<Badge
					variant="outline"
					class="text-muted-foreground"
					title="No tool calls in the last {data.usageWindowDays} days"
				>
					Unused
				</Badge>
			{/if}
			{#if (loadModeOverride[server.id] ?? server.loadMode) === 'deferred'}
				<Badge
					variant="secondary"
					title="Tools load only when the model searches for them, keeping the prompt small"
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
		<!-- Above the row's stretched click target, so it opens the usage, not the edit dialog. -->
		<button
			type="button"
			class="relative z-10 w-fit rounded-sm text-left text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			onclick={() => openUsage(server)}
		>
			{usageLabel(server)}
		</button>
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

<Tabs.Root value={activeTab} onValueChange={selectTab} class="gap-6">
	<Tabs.List class="self-start">
		<Tabs.Trigger value="servers"
			><BlocksIcon class="size-4" aria-hidden="true" />Servers</Tabs.Trigger
		>
		<Tabs.Trigger value="statistics">
			<ChartColumnIcon class="size-4" aria-hidden="true" />Statistics
		</Tabs.Trigger>
	</Tabs.List>
	<Tabs.Content value="servers" class="flex flex-col gap-6">
		{@render serverList()}
	</Tabs.Content>
	<Tabs.Content value="statistics">
		<McpUsageStats
			stats={data.stats}
			period={data.stats.period}
			servers={data.servers}
			usage={data.usage}
			onPeriodChange={(period) => navigate({ period })}
			onShowServer={openUsage}
		/>
	</Tabs.Content>
</Tabs.Root>

{#snippet serverList()}
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
				<Button size="sm" onclick={openAdd}><PlusIcon class="size-4" />Add server</Button>
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
{/snippet}

<Dialog.Root bind:open={addOpen}>
	<!-- Tall with OAuth settings: scroll inside rather than off screen. -->
	<Dialog.Content class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)]">
		<Dialog.Header>
			<Dialog.Title>Add server</Dialog.Title>
			<Dialog.Description class="text-pretty">
				Connect a remote server over HTTP or SSE, or run a local command.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitAdd} class="flex min-h-0 min-w-0 flex-col gap-6">
			<!-- Only the fields scroll; the title and buttons stay put. -->
			<div
				{@attach fadeWhenScrollable}
				class="-mx-6 -my-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-1 data-more-below:[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]"
			>
				<div class="flex flex-col gap-2">
					<Label for="add-name">Name</Label>
					<Input
						id="add-name"
						bind:value={addName}
						required
						maxlength={64}
						placeholder="my-server"
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="add-transport">Transport</Label>
					<Select.Root type="single" bind:value={addTransport}>
						<Select.Trigger id="add-transport" class="w-full"
							>{transportLabels[addTransport]}</Select.Trigger
						>
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
					{@render authFields(addAuth, 'add', false)}
				{/if}
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button {...props} type="button" variant="outline">Cancel</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={addBusy}>{addBusy ? 'Adding…' : 'Add server'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={editOpen}>
	<!-- Tall with OAuth settings: scroll inside rather than off screen. -->
	<Dialog.Content class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)]">
		<Dialog.Header>
			<Dialog.Title>Edit {data.servers.find((s) => s.id === editId)?.name ?? 'server'}</Dialog.Title
			>
			<Dialog.Description class="text-pretty"
				>Update the connection details for this MCP server.</Dialog.Description
			>
		</Dialog.Header>
		<form onsubmit={submitEdit} class="flex min-h-0 min-w-0 flex-col gap-6">
			<!-- Only the fields scroll; the title and buttons stay put. -->
			<div
				{@attach fadeWhenScrollable}
				class="-mx-6 -my-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-1 data-more-below:[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]"
			>
				<div class="flex flex-col gap-2">
					<Label for="edit-name">Name</Label>
					<Input id="edit-name" bind:value={editName} required maxlength={64} />
				</div>
				<div class="flex flex-col gap-2">
					<Label for="edit-transport">Transport</Label>
					<Select.Root type="single" bind:value={editTransport}>
						<Select.Trigger id="edit-transport" class="w-full"
							>{transportLabels[editTransport]}</Select.Trigger
						>
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
					{@render authFields(editAuth, 'edit', true)}
				{/if}
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button {...props} type="button" variant="outline">Cancel</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={editBusy}>{editBusy ? 'Saving…' : 'Save changes'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete {deleteTarget?.name}?</Dialog.Title>
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

<McpTestDialog
	bind:open={testOpen}
	serverName={testServer?.name ?? ''}
	result={testResult}
	expectedTools={testServer?.toolCount ?? null}
	busy={!!testServer && testBusyId === testServer.id}
	onRetest={testServer ? () => runTest(testServer!) : undefined}
/>

<McpUsageDialog
	bind:open={usageOpen}
	serverName={usageServer?.name ?? ''}
	detail={usageDetail}
	lastUsedAt={usageServer ? (data.usage[usageServer.id]?.lastUsedAt ?? null) : null}
	onDisable={usageServer && (enabledOverride[usageServer.id] ?? usageServer.enabled)
		? () => disableFromUsage(usageServer!)
		: undefined}
/>
