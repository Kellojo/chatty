<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import LibraryBigIcon from '@lucide/svelte/icons/library-big';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import WidgetCard from './widget-card.svelte';
	import LinkSafetyModal from './link-safety-modal.svelte';
	import { cn } from '$lib/utils.js';

	/**
	 * A ```links fence: source cards for pages the model read (typically the
	 * `fetch` tool's source cards, passed through verbatim). Payload:
	 * `{ title?, links: [{ url, title?, site?, description?, favicon?, image? }] }`
	 * or a bare array of links.
	 */
	type Source = {
		url: string;
		host: string;
		title: string;
		site: string;
		description: string | null;
		favicon: string | null;
		image: string | null;
	};

	type Props = { code: string; isIncomplete: boolean };

	let { code, isIncomplete }: Props = $props();

	const MAX_LINKS = 12;
	const uid = $props.id();

	/**
	 * Drop a trailing " | MDN" / " - GitHub" when it just repeats the site name shown above,
	 * plus a section crumb left in front of it ("X - CSS: Cascading Style Sheets | MDN").
	 */
	function stripSiteSuffix(title: string, site: string, host: string): string {
		const stripped = stripOnce(title, site, host);
		if (stripped === title) return title;
		return /^(.{8,})\s+[–—-]\s+[^–—-]*:[^–—-]*$/.exec(stripped)?.[1].trim() ?? stripped;
	}

	function stripOnce(title: string, site: string, host: string): string {
		const m =
			/^(.{2,})\s+[|·•]\s+([^|·•–—]{2,40})$/.exec(title) ??
			/^(.{8,})\s+[–—-]\s+([^|·•–—]{2,40})$/.exec(title);
		if (!m) return title;
		const tail = m[2].trim().toLowerCase();
		const siteLc = site.toLowerCase();
		const hostLc = host.toLowerCase();
		const repeats =
			siteLc.startsWith(tail) ||
			tail.startsWith(siteLc) ||
			hostLc.includes(tail.replace(/\s+/g, ''));
		return repeats ? m[1].trim() : title;
	}

	// While streaming, one placeholder row per link seen so far, so the message doesn't jump.
	const pendingRows = $derived(
		Math.min(MAX_LINKS, Math.max(1, (code.match(/"url"/g) ?? []).length))
	);

	const rec = (v: unknown): Record<string, unknown> | null =>
		typeof v === 'object' && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	const str = (v: unknown): string | null =>
		typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null;

	/** An absolute http(s) URL, or null: anything else (javascript:, data:, relative) is dropped. */
	function webUrl(v: unknown): URL | null {
		const s = str(v);
		if (!s || !URL.canParse(s)) return null;
		const u = new URL(s);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
	}

	/** Images may also be inline data:image URIs. */
	function imageUrl(v: unknown): string | null {
		const s = str(v);
		if (s && /^data:image\//i.test(s)) return s;
		return webUrl(s)?.href ?? null;
	}

	function parseSource(v: unknown): Source | null {
		const l = rec(v);
		const url = webUrl(l?.url ?? l?.href);
		if (!l || !url) return null;
		const host = url.hostname.replace(/^www\./, '');
		const site = str(l.site) ?? str(l.siteName) ?? host;
		const title = str(l.title);
		return {
			url: url.href,
			host,
			title: title
				? stripSiteSuffix(title, site, host)
				: url.pathname.length > 1
					? `${host}${url.pathname}`
					: host,
			site,
			description: str(l.description) ?? str(l.summary),
			favicon: imageUrl(l.favicon ?? l.icon),
			image: imageUrl(l.image)
		};
	}

	const data = $derived.by((): { title: string | null; links: Source[]; total: number } | null => {
		if (isIncomplete) return null;
		try {
			const parsed: unknown = JSON.parse(code);
			const root = rec(parsed);
			const list = Array.isArray(parsed) ? parsed : (root?.links ?? root?.sources);
			if (!Array.isArray(list)) return null;
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local to this derivation
			const seen = new Set<string>();
			const links: Source[] = [];
			for (const item of list) {
				const source = parseSource(item);
				if (!source || seen.has(source.url)) continue;
				seen.add(source.url);
				if (links.length < MAX_LINKS) links.push(source);
			}
			return links.length ? { title: str(root?.title), links, total: seen.size } : null;
		} catch {
			return null;
		}
	});

	// Favicons and previews are third-party requests: no referrer, lazy, and a fallback when they fail.
	const failedImages = new SvelteSet<string>();

	/** First letter or digit of the site name (or host), never a symbol or half an emoji. */
	const monogram = (source: Source): string =>
		(source.site.match(/[\p{L}\p{N}]/u) ?? source.host.match(/[\p{L}\p{N}]/u))?.[0] ?? '?';

	/** Number, title and site (plus the domain when the site name hides it) for screen readers. */
	const linkLabel = (source: Source, i: number): string =>
		`${i + 1}. ${source.title}, ${source.site}${source.site === source.host ? '' : ` (${source.host})`}`;

	/** Stable hue per host, for the monogram tile. */
	function hue(host: string): number {
		let h = 0;
		for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) % 360;
		return h;
	}

	// External links go through the same "Open external link?" confirmation as links in chat.
	let pendingUrl = $state<string | null>(null);

	function intercept(event: MouseEvent, url: string) {
		if (event.type === 'auxclick' && event.button !== 1) return;
		event.preventDefault();
		pendingUrl = url;
	}
</script>

{#snippet favicon(source: Source, large = false)}
	<div
		class={cn(
			'relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1 ring-border dark:ring-white/10',
			large ? 'size-10' : 'size-8'
		)}
		aria-hidden="true"
	>
		{#if source.favicon && !failedImages.has(source.favicon)}
			<span class="absolute inset-0 bg-white"></span>
			<img
				src={source.favicon}
				alt=""
				class={cn('relative object-contain', large ? 'size-6' : 'size-[18px]')}
				loading="lazy"
				decoding="async"
				referrerpolicy="no-referrer"
				onerror={() => failedImages.add(source.favicon!)}
			/>
		{:else}
			<span
				class="flex size-full items-center justify-center rounded-lg bg-[oklch(0.93_0.05_var(--h))] font-semibold text-[oklch(0.42_0.12_var(--h))] uppercase dark:bg-[oklch(0.34_0.07_var(--h))] dark:text-[oklch(0.9_0.06_var(--h))] {large
					? 'text-base'
					: 'text-sm'}"
				style:--h={hue(source.host)}>{monogram(source)}</span
			>
		{/if}
	</div>
{/snippet}

<WidgetCard
	icon={LibraryBigIcon}
	class="@container"
	status={data || isIncomplete ? 'ready' : 'error'}
	errorLabel="Could not render sources"
	raw={code}
	title={data?.title ?? 'Sources'}
	meta={data
		? `${data.links.length < data.total ? `${data.links.length} of ${data.total}` : data.links.length} ${data.total === 1 ? 'source' : 'sources'}`
		: 'Gathering…'}
>
	{#if !data}
		<div class="flex flex-col gap-0.5 p-1.5" role="status" aria-busy="true">
			<span class="sr-only">Gathering sources…</span>
			{#each { length: pendingRows }, i (i)}
				<div class="flex items-start gap-3 px-2.5 py-2.5" aria-hidden="true">
					<div
						class="size-8 shrink-0 animate-pulse rounded-lg bg-muted-foreground/15 motion-reduce:animate-none dark:bg-muted-foreground/30"
					></div>
					<div class="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
						<div
							class="h-2.5 w-24 animate-pulse rounded-full bg-muted-foreground/15 motion-reduce:animate-none dark:bg-muted-foreground/30"
						></div>
						<div
							class="h-3 w-3/4 animate-pulse rounded-full bg-muted-foreground/15 motion-reduce:animate-none dark:bg-muted-foreground/30"
						></div>
						<div
							class="h-2.5 w-1/2 animate-pulse rounded-full bg-muted-foreground/10 motion-reduce:animate-none dark:bg-muted-foreground/20"
						></div>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		{@const single = data.links.length === 1}
		<ol
			class={cn('grid gap-0.5 p-1.5', !single && '@2xl:grid-cols-2')}
			aria-label={data.title ?? 'Sources'}
		>
			{#each data.links as source, i (source.url)}
				<li
					class="group/link relative flex min-w-0 items-start gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60"
				>
					{@render favicon(source, single)}
					<div class="flex min-w-0 flex-1 flex-col gap-0.5">
						<div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
							<span
								class="flex size-[18px] shrink-0 items-center justify-center rounded bg-muted text-[11px] leading-none font-semibold text-foreground tabular-nums group-hover/link:bg-background group-has-[a:focus-visible]/link:bg-background"
								aria-hidden="true">{i + 1}</span
							>
							<span class="truncate">{source.site}</span>
							<ArrowUpRightIcon
								class="ml-auto size-3.5 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100 group-has-[a:focus-visible]/link:opacity-100"
								aria-hidden="true"
							/>
						</div>
						<!-- eslint-disable svelte/no-navigation-without-resolve -- external source URLs -->
						<a
							href={source.url}
							target="_blank"
							rel="noopener noreferrer"
							title={source.url}
							aria-label={linkLabel(source, i)}
							aria-describedby={source.description ? `${uid}-d${i}` : undefined}
							class="line-clamp-2 text-sm leading-snug font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
							onclick={(e) => intercept(e, source.url)}
							onauxclick={(e) => intercept(e, source.url)}>{source.title}</a
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{#if source.description}
							<p
								id="{uid}-d{i}"
								class={cn(
									'text-xs leading-relaxed text-pretty text-muted-foreground',
									single ? 'line-clamp-3' : 'line-clamp-1'
								)}
							>
								{source.description}
							</p>
						{/if}
					</div>
					{#if single && source.image && !failedImages.has(source.image)}
						<img
							src={source.image}
							alt=""
							class="hidden aspect-[1.91/1] w-36 shrink-0 self-center rounded-lg object-cover ring-1 ring-border/50 @md:block dark:ring-white/10"
							loading="lazy"
							decoding="async"
							referrerpolicy="no-referrer"
							onerror={() => failedImages.add(source.image!)}
						/>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</WidgetCard>

<LinkSafetyModal
	url={pendingUrl ?? ''}
	isOpen={pendingUrl !== null}
	onClose={() => (pendingUrl = null)}
	onConfirm={() => {
		if (pendingUrl) window.open(pendingUrl, '_blank', 'noreferrer');
	}}
/>
