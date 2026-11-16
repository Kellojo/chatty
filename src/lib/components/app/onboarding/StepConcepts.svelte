<script lang="ts">
	import BotIcon from '@lucide/svelte/icons/bot';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import CompassIcon from '@lucide/svelte/icons/compass';
	import CodeIcon from '@lucide/svelte/icons/code';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import WaypointsIcon from '@lucide/svelte/icons/waypoints';
	import { Button } from '$lib/components/ui/button/index.js';
	import ConceptScene, { type Concept } from './ConceptScene.svelte';
	import StepFooter from './StepFooter.svelte';

	let {
		isAdmin,
		hasModel,
		onback,
		onnext
	}: { isAdmin: boolean; hasModel: boolean; onback: () => void; onnext: () => void } = $props();

	const concepts = $derived<
		{
			id: Concept;
			icon: typeof BotIcon;
			title: string;
			short: string;
			body: string;
			where: string;
		}[]
	>([
		{
			id: 'chats',
			icon: MessagesSquareIcon,
			title: 'Chats & models',
			short: 'Any model, one place',
			body: 'Every chat runs on a model you pick, and you can switch mid-conversation. Attach files and images, branch a reply, or talk instead of typing.',
			where: 'The model picker under the message box'
		},
		{
			id: 'memory',
			icon: BrainIcon,
			title: 'Memory',
			short: 'It learns about you',
			body: 'Chatty notices lasting facts and preferences in your chats and remembers them, so every new chat already knows your context. You can review or edit what it knows.',
			where: 'Memory in the sidebar'
		},
		{
			id: 'agents',
			icon: BotIcon,
			title: 'Agents',
			short: 'Work in the background',
			body: 'An agent is an assistant with its own instructions and tools. Run it on a schedule or on demand, and it reports back in a chat when it’s done.',
			where: 'Agents in the sidebar'
		},
		{
			id: 'tools',
			icon: WrenchIcon,
			title: 'Skills & tools',
			short: 'Do, not just answer',
			body: 'Models can search the web, run code, read files and more. Skills are reusable playbooks that teach them how to do a task your way.',
			where: isAdmin
				? 'Settings → MCP servers, and Skills in the sidebar'
				: 'Skills in the sidebar. Your admin chooses which tools are available'
		},
		{
			id: 'coding',
			icon: CodeIcon,
			title: 'Coding',
			short: 'Agents in your repos',
			body: 'Connect a T3 Code server and hand coding tasks to agents like Claude Code or Codex. Follow along live, answer their questions, review the diff and open a pull request, all from Chatty.',
			where: 'Settings → Coding environments, then Coding on the home page'
		},
		{
			id: 'gateway',
			icon: WaypointsIcon,
			title: 'MCP gateway',
			short: 'Chatty inside other tools',
			body: 'Chatty shares its tools over MCP, so Claude Code, Codex, OpenCode or Claude.ai can use your memory, past chats, skills and more. Clients sign in once, and you choose which tools each one gets.',
			where: 'Settings → API → MCP gateway'
		},
		{
			id: 'api',
			icon: KeyRoundIcon,
			title: 'API',
			short: 'Your models, anywhere',
			body: 'An OpenAI-compatible API for chat, responses, speech and transcription, using the models connected here. Point any app or script at Chatty with an API key, or start agents from other apps.',
			where: 'Settings → API'
		}
	]);

	let active = $state(0);
	const concept = $derived(concepts[active]);
	const last = $derived(active === concepts.length - 1);
	let tabs: HTMLButtonElement[] = $state([]);

	function select(i: number, focus = false) {
		active = (i + concepts.length) % concepts.length;
		if (focus) tabs[active]?.focus();
	}

	function onkeydown(event: KeyboardEvent) {
		const keys: Record<string, number> = {
			ArrowDown: active + 1,
			ArrowRight: active + 1,
			ArrowUp: active - 1,
			ArrowLeft: active - 1,
			Home: 0,
			End: concepts.length - 1
		};
		if (!(event.key in keys)) return;
		event.preventDefault();
		select(keys[event.key], true);
	}
</script>

<header class="flex flex-col gap-2">
	<p class="text-sm font-medium text-muted-foreground">The basics</p>
	<h1
		data-step-heading
		tabindex="-1"
		class="text-2xl font-semibold tracking-tight text-balance outline-none sm:text-3xl"
	>
		How Chatty works
	</h1>
	<p class="max-w-xl text-pretty text-muted-foreground">
		The ideas that make everything else click. Look around, or skip ahead.
	</p>
</header>

<div class="mt-8 grid gap-4 md:grid-cols-[15rem_1fr]">
	<div
		role="tablist"
		aria-label="Concepts"
		aria-orientation="vertical"
		tabindex="-1"
		class="grid grid-cols-2 gap-2 md:flex md:flex-col md:self-start"
		{onkeydown}
	>
		{#each concepts as item, i (item.id)}
			{@const selected = i === active}
			<button
				bind:this={tabs[i]}
				type="button"
				role="tab"
				id="concept-tab-{item.id}"
				aria-selected={selected}
				aria-controls="concept-panel"
				tabindex={selected ? 0 : -1}
				onclick={() => select(i)}
				class={[
					'flex min-w-0 items-center gap-2.5 rounded-2xl border px-2.5 py-2 text-left transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/30 motion-reduce:transition-none max-md:last:odd:col-span-2 md:gap-3 md:px-3 md:py-3',
					selected
						? 'border-foreground/20 bg-card shadow-sm ring-1 ring-foreground/10'
						: 'border-border/50 text-foreground/75 hover:bg-card/60 hover:text-foreground md:border-transparent'
				]}
			>
				<span
					class={[
						'flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors md:size-8 md:rounded-xl',
						selected ? 'bg-foreground text-background' : 'bg-muted'
					]}
				>
					<item.icon class="size-4" aria-hidden="true" />
				</span>
				<span class="flex flex-col">
					<span class="truncate text-sm font-medium">{item.title}</span>
					<span class="hidden text-xs text-muted-foreground md:block">{item.short}</span>
				</span>
			</button>
		{/each}
	</div>

	<div
		id="concept-panel"
		role="tabpanel"
		aria-labelledby="concept-tab-{concept.id}"
		class="overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm"
	>
		<div class="h-52 border-b border-border/60 bg-muted/40 sm:h-64">
			{#key concept.id}
				<ConceptScene concept={concept.id} />
			{/key}
		</div>
		<div class="flex flex-col gap-3 p-5 sm:p-6">
			<div class="flex items-center justify-between gap-3">
				<h2 class="text-lg font-semibold tracking-tight">{concept.title}</h2>
				<span class="text-xs text-muted-foreground tabular-nums"
					>{active + 1} / {concepts.length}</span
				>
			</div>
			<p class="text-pretty text-muted-foreground">{concept.body}</p>
			<p
				class={[
					'flex items-start gap-1.5 text-sm',
					hasModel ? 'text-foreground/80' : 'text-muted-foreground/70'
				]}
			>
				<CompassIcon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
				<span>
					<span class="sr-only">Find it in: </span>{concept.where}{#if !hasModel}
						<span class="text-muted-foreground"> · needs a model</span>{/if}
				</span>
			</p>
		</div>
	</div>
</div>

<StepFooter
	{onback}
	onnext={last ? onnext : () => select(active + 1)}
	nextLabel={last ? 'Continue' : `Next: ${concepts[active + 1]?.title}`}
>
	{#snippet secondary()}
		{#if !last}
			<Button variant="ghost" class="hidden text-foreground/70 sm:inline-flex" onclick={onnext}
				>Skip tour</Button
			>
		{/if}
	{/snippet}
</StepFooter>
