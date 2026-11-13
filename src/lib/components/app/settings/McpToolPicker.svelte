<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import { Button } from '$lib/components/ui/button/index.js';
	import ToolAllowlist from '$lib/components/app/ToolAllowlist.svelte';
	import { accessToToolNames, defaultAccess } from '$lib/mcp-access.js';
	import type { McpGatewayServer, McpKeyAccess, ToolInfo } from '$lib/types.js';

	/**
	 * Picks the MCP gateway tools an API key may use. Loads the tool list once:
	 * `tools` and `selected` are bound, so the owner keeps them across remounts.
	 */
	let {
		servers,
		initialAccess,
		tools = $bindable(null),
		selected = $bindable([]),
		reveal = false,
		onLoaded
	}: {
		servers: McpGatewayServer[];
		/** The access the picks start from once the tools load. */
		initialAccess: McpKeyAccess;
		tools?: ToolInfo[] | null;
		/** Picked tool names. */
		selected?: string[];
		/** Scroll into view when shown (e.g. right after turning the gateway on). */
		reveal?: boolean;
		/** After the tool list loaded and the picks were set from `initialAccess`. */
		onLoaded?: (selected: string[]) => void;
	} = $props();

	let failed = $state(false);
	let loading = false;
	let section = $state<HTMLElement | null>(null);

	const signInNeeded = $derived(servers.filter((s) => s.needsSignIn));
	/** Agent tools start runs that use each agent's own tools, past the picks here. */
	const agentToolsPicked = $derived(
		!!tools && tools.some((t) => t.server === 'agents' && selected.includes(t.name))
	);
	const defaultsHint = $derived(
		`Every tool of: ${servers
			.filter((s) => s.exposedByDefault)
			.map((s) => s.name)
			.join(', ')}`
	);

	async function load() {
		if (tools || loading) return;
		loading = true;
		failed = false;
		try {
			const res = await fetch('/api/mcp-gateway/tools');
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			const payload = (await res.json()) as { tools: ToolInfo[] };
			selected = accessToToolNames(initialAccess, servers, payload.tools);
			tools = payload.tools;
			onLoaded?.(selected);
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}

	// Once, when shown.
	onMount(() => {
		void load();
		if (reveal) {
			requestAnimationFrame(() =>
				section?.scrollIntoView({
					behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
					block: 'start'
				})
			);
		}
	});

	function resetToDefaults() {
		if (tools) selected = accessToToolNames(defaultAccess(servers), servers, tools);
	}
</script>

<section
	bind:this={section}
	class="flex scroll-mt-2 flex-col gap-3"
	aria-labelledby="mcp-tools-heading"
>
	<div class="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-4">
		<div class="flex min-w-0 flex-col gap-1">
			<h3 id="mcp-tools-heading" class="text-sm font-medium">
				MCP tools
				{#if tools}
					<span class="ml-1 font-normal text-muted-foreground tabular-nums">
						{selected.length} of {tools.length}
					</span>
				{/if}
			</h3>
			<p class="text-xs text-muted-foreground">
				Picking every tool of a server also includes tools it adds later.
			</p>
		</div>
		{#if tools}
			<Button
				type="button"
				variant="ghost"
				size="sm"
				class="-ml-2.5 sm:ml-0"
				onclick={resetToDefaults}
				title={defaultsHint}
			>
				<RotateCcwIcon class="size-4" />Reset to defaults
			</Button>
		{/if}
	</div>
	{#if tools}
		<ToolAllowlist
			{tools}
			bind:value={selected}
			emptyWarning="No tools picked. Clients using this key will see none."
		/>
	{:else if failed}
		<div
			class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-3 py-3"
		>
			<p class="text-sm text-muted-foreground">
				Couldn't load the tools. Some MCP servers may be unreachable.
			</p>
			<Button type="button" variant="outline" size="sm" onclick={load}>
				<RotateCcwIcon class="size-4" />Retry
			</Button>
		</div>
	{:else}
		<p class="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
			<Loader2Icon class="size-4 animate-spin motion-reduce:animate-none" />Loading tools…
		</p>
	{/if}
	{#if agentToolsPicked}
		<p
			class="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
		>
			<TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			<span>
				Agent tools can create and start your agents. A run uses that agent's own tools, so a client
				with these can reach more than you picked here. Only allow them for clients you fully trust.
			</span>
		</p>
	{/if}
	{#if signInNeeded.length > 0}
		<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
			<LogInIcon class="size-3.5 shrink-0" aria-hidden="true" />
			<span>
				{signInNeeded.map((s) => s.name).join(', ')}
				{signInNeeded.length === 1 ? 'is' : 'are'} missing: sign in under
				<a
					class="font-medium text-foreground underline underline-offset-4"
					href={resolve('/settings/connections')}>Connected apps</a
				>
				to pick {signInNeeded.length === 1 ? 'its' : 'their'} tools.
			</span>
		</p>
	{/if}
</section>
