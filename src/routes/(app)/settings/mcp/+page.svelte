<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import McpUsageStats from '$lib/components/app/settings/McpUsageStats.svelte';
	import { DEFAULT_USAGE_PERIOD, type UsagePeriod } from '$lib/components/app/usage/usage.js';
	import McpUsageDialog from '$lib/components/app/settings/McpUsageDialog.svelte';
	import McpContextBar, {
		type ContextEntry
	} from '$lib/components/app/settings/McpContextBar.svelte';
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
	import SearchIcon from '@lucide/svelte/icons/search';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CopyButton from '$lib/components/app/settings/CopyValue.svelte';
	import BlocksIcon from '@lucide/svelte/icons/blocks';
	import { BUILTIN_ICON, BUILTIN_PURPOSE } from '$lib/components/app/settings/mcp-builtins.js';
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

	/** Hover text for a server's usage columns: the full picture behind the short numbers. */
	function usageTitle(server: McpServerInfo): string {
		const usage = data.usage[server.id];
		const window = `the last ${data.usageWindowDays} days`;
		if (!usage?.calls) return `No tool calls in ${window} · click for details`;
		const parts = [`${plural(usage.calls, 'call')} in ${window}`, plural(usage.users, 'user')];
		if (usage.errors > 0) parts.push(`${plural(usage.errors, 'failure')}`);
		return `${parts.join(' · ')} · click for details`;
	}

	/** Share of failed calls, when it's high enough to be worth flagging on the row. */
	function failureRate(server: McpServerInfo): number | null {
		const usage = data.usage[server.id];
		// A failure or two on a barely used server is noise, not a signal.
		if (!usage || usage.calls < FAILURE_FLAG_MIN_CALLS || usage.errors === 0) return null;
		const rate = Math.max(1, Math.round((usage.errors / usage.calls) * 100));
		return rate >= FAILURE_FLAG_PERCENT ? rate : null;
	}
	const FAILURE_FLAG_PERCENT = 10;
	const FAILURE_FLAG_MIN_CALLS = 5;

	/** Non-default connection settings, shown as quiet labels before the host. */
	function rowFlags(server: McpServerInfo) {
		const flags: { label: string; title: string }[] = [];
		if (server.auth === 'oauth')
			flags.push({ label: 'OAuth', title: 'Each user signs in under Settings → Connected apps' });
		if (server.transport === 'sse')
			flags.push({ label: 'SSE', title: 'Server-sent events transport' });
		if (server.transport === 'stdio')
			flags.push({ label: 'stdio', title: 'Runs a local command on the Chatty host' });
		return flags;
	}

	/** Shared by the column header and every row, so the stat columns stay aligned. */
	const STAT_GROUP = 'mr-2 flex gap-3 px-1';
	const COL = {
		tools: 'w-9',
		calls: 'w-18 whitespace-nowrap',
		lastUsed: 'w-15 whitespace-nowrap'
	} as const;

	/** Last used before the usage window: the date recedes like an empty cell. */
	function isStale(server: McpServerInfo): boolean {
		const at = data.usage[server.id]?.lastUsedAt;
		return !at || Date.now() - at > data.usageWindowDays * 86_400_000;
	}
	/** An empty stat cell (no tools listed, no calls), so used servers stand out. */
	const DIM = 'text-muted-foreground/70';

	/** When a server was last called: "7m ago", "50d ago", then a short date; "–" if never. */
	const lastUsed = (server: McpServerInfo) => {
		const at = data.usage[server.id]?.lastUsedAt;
		if (!at) return '–';
		const days = Math.floor((Date.now() - at) / 86_400_000);
		if (days < 30) return formatTimeAgo(at);
		if (days < 90) return `${days}d ago`;
		return new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(at);
	};

	/** The host of a remote server's URL; the full URL stays in the hover text. */
	function shortConnection(server: McpServerInfo): string {
		if (server.transport === 'stdio') {
			// The package or script it runs names it best: "@scope/server-x" -> "server-x".
			const last = server.args.findLast((arg) => !arg.startsWith('-'));
			return last?.split(/[\\/]/).pop() || (server.command ?? '');
		}
		if (!server.url) return '';
		try {
			const url = new URL(server.url);
			// The port stays in the hover text; the host is what tells servers apart.
			return url.hostname + (url.pathname === '/' || url.pathname === '/mcp' ? '' : url.pathname);
		} catch {
			return server.url;
		}
	}

	const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

	let query = $state('');
	const needle = $derived(query.trim().toLowerCase());
	const matches = (server: McpServerInfo) =>
		!needle ||
		[server.name, BUILTIN_PURPOSE[server.name] ?? '', connectionLabel(server)].some((text) =>
			text.toLowerCase().includes(needle)
		);
	const shownCustom = $derived(customServers.filter(matches));
	const shownBuiltin = $derived(builtinServers.filter(matches));

	/** A list's enabled servers whose tool definitions were measured (on their last connect). */
	const contextEntries = (servers: McpServerInfo[]): ContextEntry[] =>
		servers
			.filter((s) => (enabledOverride[s.id] ?? s.enabled) && s.toolTokens)
			.map((s) => ({
				id: s.id,
				name: s.name,
				tokens: s.toolTokens ?? 0,
				toolCount: s.toolCount,
				always: (loadModeOverride[s.id] ?? s.loadMode) === 'always'
			}));
	const onCount = (servers: McpServerInfo[]) =>
		servers.filter((s) => enabledOverride[s.id] ?? s.enabled).length;
	const matchCount = (shown: McpServerInfo[], all: McpServerInfo[]) =>
		`${shown.length} of ${all.length} match`;

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
	{@const calls = data.usage[server.id]?.calls ?? 0}
	{@const failing = failureRate(server)}
	{@const alwaysLoaded = (loadModeOverride[server.id] ?? server.loadMode) === 'always'}
	<!-- Phones have no stat columns: the numbers join the meta line instead. -->
	{@const mobileParts = [
		enabled ? null : 'Off',
		server.toolCount ? plural(server.toolCount, 'tool') : null,
		calls
			? `${plural(calls, 'call')} · ${lastUsed(server)}`
			: data.usage[server.id]?.lastUsedAt
				? `Last used ${lastUsed(server)}`
				: 'No calls'
	].filter((part): part is string => !!part)}
	{@const mobileStats = mobileParts.join(' · ')}
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
			<!-- Only what departs from the norm; tool count and usage live in the columns. -->
			{#if alwaysLoaded}
				<!-- Common among built-ins, so a quiet glyph rather than a label. -->
				<span
					class="text-muted-foreground"
					title="Always loaded: all its tools are in every prompt instead of loading when the model searches for them"
					><ZapIcon class="size-3.5" /><span class="sr-only">Always loaded</span></span
				>
			{/if}
			{#if failing !== null}
				<!-- Opens the usage details, where the failing tools are listed. -->
				<button
					type="button"
					class="relative z-10 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					title="{data.usage[server.id]?.errors} of {data.usage[server.id]
						?.calls} calls failed in the last {data.usageWindowDays} days · click for details"
					onclick={() => openUsage(server)}
				>
					<Badge
						variant="outline"
						class="border-amber-500/40 font-normal text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
						><TriangleAlertIcon class="size-3" />{failing}% failed</Badge
					>
				</button>
			{/if}
		{/snippet}
		{#snippet meta()}
			<!-- Wraps to a second line rather than cutting the purpose short. -->
			<span
				class="line-clamp-2 block whitespace-normal"
				title={connection || BUILTIN_PURPOSE[server.name] || undefined}
			>
				<!-- Settings that differ from the default lead the line as plain labels. -->
				{#each rowFlags(server) as flag (flag.label)}<span
						class="font-medium text-foreground/70"
						title={flag.title}>{flag.label}</span
					><span aria-hidden="true" class="mx-1">·</span>{/each}
				{#if connection}
					<span class="font-mono" title={connection}>{shortConnection(server)}</span>
				{:else}
					{BUILTIN_PURPOSE[server.name] ?? ''}
				{/if}
			</span>
			<!-- One unbreakable chunk per stat, so a wrap never strands a separator. -->
			<span class="flex flex-wrap gap-x-1.5 text-foreground/70 tabular-nums sm:hidden">
				{#each mobileParts as part, i (i)}
					<span class="whitespace-nowrap {part === 'No calls' ? DIM : ''}"
						>{#if i > 0}<span aria-hidden="true" class="mr-1.5">·</span>{/if}{part}</span
					>
				{/each}
			</span>
		{/snippet}
		{#snippet trailing()}
			{#if testBusyId === server.id}
				<span class="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
					<Loader2Icon class="size-4 animate-spin" />Testing…
				</span>
			{/if}
			<!-- Opens the usage details; sits above the row's stretched edit target. -->
			<button
				type="button"
				class="{STAT_GROUP} rounded-md py-1 text-xs text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-sm:hidden"
				class:opacity-60={!enabled}
				title={usageTitle(server)}
				aria-label="Usage of {server.name}: {mobileStats}"
				onclick={() => openUsage(server)}
			>
				<span class="{COL.tools} text-right {server.toolCount ? '' : DIM}"
					>{server.toolCount ?? '–'}</span
				>
				<span class="{COL.calls} text-right {calls ? '' : DIM}"
					>{calls ? calls.toLocaleString() : '–'}</span
				>
				<span class="{COL.lastUsed} text-right {isStale(server) ? DIM : ''}"
					>{lastUsed(server)}</span
				>
			</button>
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

{#snippet columnHeader()}
	<!-- Column labels; mirrors the row's trailing layout (stats, switch, menu). -->
	<div
		class="sticky top-0 z-20 flex items-center gap-2 border-y border-border/60 bg-card px-(--card-spacing) py-1.5 text-xs font-medium text-foreground/70 max-sm:hidden"
		aria-hidden="true"
	>
		<span class="flex-1"></span>
		<span class={STAT_GROUP}>
			<span class="{COL.tools} text-right">Tools</span>
			<span
				class="{COL.calls} text-right"
				title="Tool calls in the last {data.usageWindowDays} days"
				>Calls ({data.usageWindowDays}d)</span
			>
			<span class="{COL.lastUsed} text-right" title="Most recent tool call, ever">Last used</span>
		</span>
		<!-- Switch, then the actions menu. -->
		<span class="w-11"></span>
		<span class="w-8"></span>
	</div>
{/snippet}

<!-- Each list gets its own column labels, which stick while it scrolls (as on Models). -->
{#snippet serverRows(servers: McpServerInfo[], label: string)}
	{@render columnHeader()}
	<ul class="divide-y divide-border/60 border-t border-border/60 sm:border-t-0" aria-label={label}>
		{#each servers as server (server.id)}
			{@render serverRow(server)}
		{/each}
	</ul>
{/snippet}

<!-- How a list's servers split the prompt; hidden while searching or before anything was measured. -->
{#snippet contextBar(servers: McpServerInfo[], label: string)}
	{@const entries = contextEntries(servers)}
	{#if entries.length > 0 && !needle}
		<McpContextBar {entries} {label} />
	{/if}
{/snippet}

{#snippet serverList()}
	{#if data.servers.length > 8}
		<div class="relative">
			<SearchIcon
				class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				type="search"
				bind:value={query}
				placeholder="Search servers"
				aria-label="Search servers"
				class="h-9 pl-9"
			/>
		</div>
	{/if}
	{#if needle && shownCustom.length === 0 && shownBuiltin.length === 0}
		<p class="px-1 py-6 text-center text-sm text-muted-foreground">
			No servers match “{query.trim()}”.
		</p>
	{/if}
	{#if !needle || shownCustom.length > 0}
		<SettingsSection
			title="Your servers"
			description={needle
				? matchCount(shownCustom, customServers)
				: customServers.length
					? `${onCount(customServers)} of ${customServers.length} on`
					: "Servers you've connected over HTTP, SSE or stdio."}
			flush
			class="overflow-visible"
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
				{@render contextBar(customServers, 'Tool context of your servers')}
				{@render serverRows(shownCustom, 'Your MCP servers')}
			{/if}
		</SettingsSection>
	{/if}

	{#if shownBuiltin.length > 0}
		<SettingsSection
			title="Built-in"
			description={needle
				? matchCount(shownBuiltin, builtinServers)
				: `Included with Chatty · ${onCount(builtinServers)} of ${builtinServers.length} on`}
			flush
			class="overflow-visible"
		>
			{@render contextBar(builtinServers, 'Tool context of the built-in servers')}
			{@render serverRows(shownBuiltin, 'Built-in MCP servers')}
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
