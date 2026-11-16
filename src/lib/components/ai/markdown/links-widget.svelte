<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import LibraryBigIcon from '@lucide/svelte/icons/library-big';
	import WidgetCard from './widget-card.svelte';
	import LinkSafetyModal from './link-safety-modal.svelte';
	import { inlineImageUrl } from './image-url.js';

	/**
	 * A ```links fence: an answer's sources as a footnote line under it, typically the
	 * `fetch` / `web_search` source cards passed through verbatim. Payload:
	 * `{ title?, links: [{ url, title?, site?, description?, favicon? }] }`
	 * or a bare array of links.
	 */
	type Source = {
		url: string;
		host: string;
		title: string;
		site: string;
		description: string | null;
		favicon: string | null;
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
			// A remote favicon can't be loaded directly (image-url.ts); the server proxies it,
			// but only for sites the user's own tools fetched.
			favicon:
				inlineImageUrl(l.favicon ?? l.icon) ?? `/api/favicon?host=${encodeURIComponent(host)}`
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

	// Favicons and previews load lazily, without a referrer, and fall back when they fail.
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

{#snippet favicon(source: Source)}
	<!-- Just the icon, no tile or border. -->
	{#if source.favicon && !failedImages.has(source.favicon)}
		<img
			src={source.favicon}
			alt=""
			class="size-3.5 shrink-0 rounded-[3px] object-contain"
			loading="lazy"
			decoding="async"
			referrerpolicy="no-referrer"
			onerror={() => failedImages.add(source.favicon!)}
		/>
	{:else}
		<span
			class="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-[oklch(0.9_0.07_var(--h))] text-[8px] leading-none font-semibold text-[oklch(0.4_0.12_var(--h))] uppercase dark:bg-[oklch(0.36_0.08_var(--h))] dark:text-[oklch(0.92_0.06_var(--h))]"
			style:--h={hue(source.host)}>{monogram(source)}</span
		>
	{/if}
{/snippet}

{#if data || isIncomplete}
	<!--
		A quiet footnote line under the answer, not a card: the inline [1], [2] citations already
		tie claims to sources, so this only names the sites. Page titles are in the tooltip and the
		links' accessible names.
	-->
	<section
		class="mt-4 mb-1 flex items-start gap-3 border-t border-border/50 pt-2.5 text-xs leading-5 text-muted-foreground"
		aria-labelledby="{uid}-h"
	>
		<h3 id="{uid}-h" class="shrink-0 font-medium text-foreground/80">
			{data?.title ?? 'Sources'}
		</h3>
		{#if !data}
			<div class="flex flex-wrap gap-x-3 gap-y-1" role="status" aria-busy="true">
				<span class="sr-only">Gathering sources…</span>
				{#each { length: pendingRows }, i (i)}
					<span class="flex h-5 items-center gap-1.5" aria-hidden="true">
						<span
							class="size-3.5 animate-pulse rounded-[3px] bg-muted-foreground/15 motion-reduce:animate-none dark:bg-muted-foreground/30"
						></span>
						<span
							class="h-2 w-16 animate-pulse rounded-full bg-muted-foreground/15 motion-reduce:animate-none dark:bg-muted-foreground/30"
						></span>
					</span>
				{/each}
			</div>
		{:else}
			<ol class="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
				{#each data.links as source, i (source.url)}
					<li class="min-w-0">
						<!-- eslint-disable svelte/no-navigation-without-resolve -- external source URLs -->
						<a
							href={source.url}
							target="_blank"
							rel="noopener noreferrer"
							title="{source.title} — {source.host}"
							aria-label={linkLabel(source, i)}
							aria-describedby={source.description ? `${uid}-d${i}` : undefined}
							class="group/link flex min-w-0 items-center gap-1.5 rounded-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
							onclick={(e) => intercept(e, source.url)}
							onauxclick={(e) => intercept(e, source.url)}
						>
							<span class="tabular-nums" aria-hidden="true">{i + 1}</span>
							{@render favicon(source)}
							<span
								class="max-w-48 truncate decoration-foreground/30 underline-offset-2 group-hover/link:underline"
								>{source.site}</span
							>
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{#if source.description}
							<span id="{uid}-d{i}" class="sr-only">{source.description}</span>
						{/if}
					</li>
				{/each}
				{#if data.links.length < data.total}
					<li class="text-muted-foreground/70">+{data.total - data.links.length} more</li>
				{/if}
			</ol>
		{/if}
	</section>
{:else}
	<WidgetCard
		icon={LibraryBigIcon}
		status="error"
		errorLabel="Could not render sources"
		raw={code}
		title={null}
	/>
{/if}

<LinkSafetyModal
	url={pendingUrl ?? ''}
	isOpen={pendingUrl !== null}
	onClose={() => (pendingUrl = null)}
	onConfirm={() => {
		if (pendingUrl) window.open(pendingUrl, '_blank', 'noreferrer');
	}}
/>
