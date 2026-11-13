<script lang="ts" module>
	export const GUIDES = ['inference', 'mcp', 'agents'] as const;
	export type Guide = (typeof GUIDES)[number];
</script>

<script lang="ts">
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import { cn } from '$lib/utils.js';
	import type { ApiKey, McpGatewayServer, McpGatewayUsage } from '$lib/types.js';
	import AgentRunsGuide from './AgentRunsGuide.svelte';
	import InferenceGuide from './InferenceGuide.svelte';
	import McpGatewayGuide from './McpGatewayGuide.svelte';
	import { SCOPE_INFO, type ApiScope } from './scopes.js';

	let {
		guide,
		onGuideChange,
		origin,
		keys,
		gateway,
		agents,
		isAdmin,
		onCreateKey,
		onEditKey
	}: {
		guide: Guide;
		onGuideChange: (guide: Guide) => void;
		origin: string;
		keys: ApiKey[];
		gateway: { servers: McpGatewayServer[]; usage: McpGatewayUsage };
		agents: { id: string; name: string }[];
		isAdmin: boolean;
		onCreateKey: (scope: ApiScope) => void;
		onEditKey: (key: ApiKey) => void;
	} = $props();

	const SCOPE_OF: Record<Guide, ApiScope> = {
		inference: 'llm:invoke',
		mcp: 'mcp:use',
		agents: 'agents:run'
	};

	const keyCount = (scope: ApiScope) => keys.filter((k) => k.scopes.includes(scope)).length;

	/** Arrow keys move between the tasks, like a tab list. */
	function onKeydown(event: KeyboardEvent) {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const next = GUIDES[(GUIDES.indexOf(guide) + step + GUIDES.length) % GUIDES.length];
		onGuideChange(next);
		(event.currentTarget as HTMLElement)
			.querySelector<HTMLElement>(`[data-guide="${next}"]`)
			?.focus();
	}
</script>

<SettingsSection
	title="Use the API"
	description="Pick what you want to do for the key, endpoint and setup it needs."
>
	<div
		role="tablist"
		aria-label="API tasks"
		tabindex="-1"
		class="grid gap-2 sm:grid-cols-3"
		onkeydown={onKeydown}
	>
		{#each GUIDES as id (id)}
			{@const scope = SCOPE_OF[id]}
			{@const task = SCOPE_INFO[scope]}
			{@const selected = guide === id}
			{@const count = keyCount(scope)}
			<button
				type="button"
				role="tab"
				id="guide-tab-{id}"
				data-guide={id}
				aria-selected={selected}
				aria-controls="guide-panel"
				tabindex={selected ? 0 : -1}
				class={cn(
					'flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
					selected
						? 'border-primary/60 bg-primary/5'
						: 'border-border/60 hover:border-border hover:bg-accent/40'
				)}
				onclick={() => onGuideChange(id)}
			>
				<span class="flex w-full items-center gap-2">
					<span
						class={cn(
							'flex size-7 shrink-0 items-center justify-center rounded-lg',
							selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
						)}
					>
						<task.icon class="size-4" />
					</span>
					<span class="text-sm font-medium">{task.title}</span>
				</span>
				<span class="text-xs text-muted-foreground">{task.description}</span>
				<span class="mt-auto flex items-center gap-1.5 text-xs text-muted-foreground">
					<code class="rounded bg-muted px-1 py-0.5">{scope}</code>
					<span>· {count === 0 ? 'no keys' : `${count} ${count === 1 ? 'key' : 'keys'}`}</span>
				</span>
			</button>
		{/each}
	</div>
	<div
		id="guide-panel"
		role="tabpanel"
		aria-labelledby="guide-tab-{guide}"
		class="border-t border-border/60 pt-5"
	>
		{#if guide === 'inference'}
			<InferenceGuide {origin} {keys} {isAdmin} {onCreateKey} {onEditKey} />
		{:else if guide === 'mcp'}
			<McpGatewayGuide
				{origin}
				{keys}
				servers={gateway.servers}
				usage={gateway.usage}
				{isAdmin}
				{onCreateKey}
				{onEditKey}
			/>
		{:else}
			<AgentRunsGuide {origin} {keys} {agents} {onCreateKey} {onEditKey} />
		{/if}
	</div>
</SettingsSection>
