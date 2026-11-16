<script lang="ts">
	import BanIcon from '@lucide/svelte/icons/ban';
	import BotIcon from '@lucide/svelte/icons/bot';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FolderLockIcon from '@lucide/svelte/icons/folder-lock';
	import LockIcon from '@lucide/svelte/icons/lock';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import SaveIcon from '@lucide/svelte/icons/save';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import ShieldXIcon from '@lucide/svelte/icons/shield-x';
	import ScanSearchIcon from '@lucide/svelte/icons/scan-search';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import { cn } from '$lib/utils.js';

	/**
	 * How private data works, at a glance: what can be private, the fork it
	 * takes (trusted models yes, other models never), what tools do, and how
	 * things become private. Shown where the feature is turned on (Private data) and
	 * used (Conversation).
	 */
	let {
		trustedProviders,
		class: className
	}: {
		/** Names of the providers trusted with private data, when the page knows them. */
		trustedProviders?: string[];
		class?: string;
	} = $props();

	const sources = [
		{ icon: MessageSquareIcon, label: 'Locked chats', title: undefined },
		{ icon: BrainIcon, label: 'Private memory notes', title: undefined },
		{ icon: FolderLockIcon, label: 'Private documents', title: 'Files under documents/private' },
		{ icon: BotIcon, label: 'Private agents', title: undefined }
	];

	const ways = [
		{ icon: LockIcon, text: 'You mark it private' },
		{ icon: MessageSquareIcon, text: 'A chat reads something private' },
		{ icon: SaveIcon, text: 'A private chat saves a note or file' },
		{ icon: ScanSearchIcon, text: 'A saved note looks sensitive' }
	];
</script>

{#snippet connector(ok: boolean, label: string)}
	<!-- A labelled link from the private card to a destination: solid ✓ or dashed ✕ across on wide
	     screens; on phones, where the cards stack, just the chip and word above each card. -->
	{@const line = ok ? 'bg-emerald-600/60 dark:bg-emerald-400/60' : 'border-dashed border-current'}
	<div
		class={cn(
			'flex items-center gap-1.5 text-xs font-medium max-md:pl-1 md:px-1.5',
			ok ? 'text-emerald-800 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-300'
		)}
		aria-hidden="true"
	>
		<span class={cn('h-px w-5 max-md:hidden', ok ? line : `border-t ${line}`)}></span>
		<span
			class={cn(
				'flex size-5 shrink-0 items-center justify-center rounded-full',
				ok ? 'bg-emerald-500/15' : 'bg-amber-500/15'
			)}
		>
			{#if ok}<CheckIcon class="size-3" />{:else}<BanIcon class="size-3" />{/if}
		</span>
		<span class="whitespace-nowrap">{label}</span>
		<span class={cn('h-px w-3 max-md:hidden', ok ? line : `border-t ${line}`)}></span>
		<ChevronRightIcon class="-ml-2 size-3.5 shrink-0 max-md:ml-0 max-md:rotate-90" />
	</div>
{/snippet}

<figure
	role="group"
	aria-labelledby="private-diagram-summary"
	class={cn(
		'flex flex-col gap-4 rounded-2xl border border-border/60 bg-muted/40 p-4 text-sm',
		className
	)}
>
	<p id="private-diagram-summary" class="sr-only">
		Private chats, notes, documents and agents only go to trusted models. Other models never see
		them. Tools work as usual.
	</p>

	<!-- The fork: private things → trusted models (yes) and other models (never). -->
	<div
		class="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.2fr)] md:grid-rows-[auto_auto] md:items-center md:gap-x-0 md:gap-y-3"
	>
		<section
			class="flex flex-col gap-2.5 rounded-xl border bg-background p-3 md:row-span-2 md:self-stretch"
		>
			<h4 class="font-semibold">What can be private</h4>
			<ul class="flex flex-col gap-2">
				{#each sources as source (source.label)}
					{@const Icon = source.icon}
					<li class="flex items-center gap-2.5">
						<span
							class="flex size-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
						>
							<Icon class="size-4" aria-hidden="true" />
						</span>
						<span class="min-w-0" title={source.title}>{source.label}</span>
					</li>
				{/each}
			</ul>
		</section>

		<div class="flex items-center">{@render connector(true, 'only')}</div>
		<section
			class="flex flex-col gap-1 rounded-xl border border-emerald-600/40 bg-emerald-500/[0.07] p-3 dark:border-emerald-400/40"
		>
			<h4 class="flex items-center gap-1.5 font-semibold text-emerald-800 dark:text-emerald-300">
				<ShieldCheckIcon class="size-3.5" aria-hidden="true" />Only trusted models
			</h4>
			{#if trustedProviders === undefined}
				<p class="text-xs text-muted-foreground">Providers your admin trusts with private data</p>
			{:else if trustedProviders.length > 0}
				<ul class="flex flex-wrap gap-1.5" aria-label="Trusted providers">
					{#each trustedProviders as name (name)}
						<li
							class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:text-emerald-200"
						>
							{name}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-xs font-medium text-amber-700 dark:text-amber-400">
					No provider is trusted yet
				</p>
			{/if}
			<p class="text-xs leading-relaxed text-muted-foreground">
				Replies, titles, summaries, memory, images, speech and agents from a private chat all stay
				here.
			</p>
		</section>

		<div class="flex items-center md:col-start-2 md:row-start-2">
			{@render connector(false, 'never')}
		</div>
		<section
			class="flex flex-col gap-1 rounded-xl border border-amber-600/40 bg-amber-500/[0.07] p-3 md:col-start-3 md:row-start-2 dark:border-amber-400/40"
		>
			<h4 class="flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-300">
				<ShieldXIcon class="size-3.5" aria-hidden="true" />All other models
			</h4>
			<p class="text-xs leading-relaxed text-muted-foreground">
				Never see private data. Chats on these models show a “private results hidden” note instead.
			</p>
		</section>
	</div>

	<!-- Tools are outside the fork: they aren't a destination the feature decides. -->
	<p
		class="flex items-start gap-2.5 rounded-xl border bg-background/60 px-3 py-2.5 text-xs text-foreground/80"
	>
		<WrenchIcon class="mt-px size-4 shrink-0" aria-hidden="true" />
		<span>
			<span class="font-semibold">Tools work as usual.</span>
			<span>What they send out, like a web search or an MCP server call, is up to you.</span>
		</span>
	</p>

	<!-- How something ends up in the private card. -->
	<figcaption class="flex flex-col gap-2 border-t pt-3">
		<span class="text-xs font-semibold">Something becomes private when</span>
		<ul class="grid gap-x-6 gap-y-2 sm:grid-flow-col sm:grid-rows-2">
			{#each ways as way (way.text)}
				{@const Icon = way.icon}
				<li class="flex items-center gap-2 text-[13px] text-foreground/80">
					<Icon
						class="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-400"
						aria-hidden="true"
					/>
					<span>{way.text}</span>
				</li>
			{/each}
		</ul>
	</figcaption>
</figure>
