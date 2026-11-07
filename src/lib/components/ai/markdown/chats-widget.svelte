<script lang="ts">
	import { resolve } from '$app/paths';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import {
		isCodingPullRequestState,
		type CodingPullRequestState,
		type CodingTaskStatus
	} from '$lib/coding-environments.js';
	import {
		CODING_PR_STATE_STYLE,
		CODING_STATUS_STYLE,
		isCodingTaskStatus
	} from '$lib/coding-status.js';
	import PullRequestIcon from '$lib/components/app/PullRequestIcon.svelte';
	import { pullRequestNumber } from '$lib/coding-task-details.js';
	import DiffStat from '$lib/components/app/DiffStat.svelte';
	import WidgetCard from './widget-card.svelte';

	/**
	 * A ```chats fence: an overview of conversations, typically search_chats
	 * results the model passes through (optionally with a one-line summary each).
	 */
	type Coding = {
		project: string | null;
		status: CodingTaskStatus;
		model: string | null;
		branch: string | null;
		pullRequest: string | null;
		pullRequestState: CodingPullRequestState | null;
		linesAdded: number;
		linesRemoved: number;
		waitingFor: string | null;
		lastError: string | null;
	};

	type Chat = {
		id: string;
		title: string;
		updatedAt: number | null;
		summary: string | null;
		coding: Coding | null;
	};

	type Props = {
		code: string;
		isIncomplete: boolean;
	};

	let { code, isIncomplete }: Props = $props();

	const rec = (v: unknown): Record<string, unknown> | null =>
		typeof v === 'object' && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
	const num = (v: unknown): number | null =>
		typeof v === 'number' && Number.isFinite(v) ? v : null;

	function parseCoding(v: unknown): Coding | null {
		const c = rec(v);
		if (!c || !isCodingTaskStatus(c.status)) return null;
		const pr = str(c.pullRequest);
		return {
			project: str(c.project),
			status: c.status,
			model: str(c.model),
			branch: str(c.branch) ?? str(c.baseBranch),
			pullRequest: pr && /^https?:\/\//.test(pr) ? pr : null,
			pullRequestState: isCodingPullRequestState(c.pullRequestState) ? c.pullRequestState : null,
			linesAdded: num(c.linesAdded) ?? 0,
			linesRemoved: num(c.linesRemoved) ?? 0,
			waitingFor: str(rec(c.waitingFor)?.title),
			lastError: str(c.lastError)
		};
	}

	function parseChat(v: unknown): Chat | null {
		const c = rec(v);
		const id = str(c?.id);
		if (!c || !id) return null;
		return {
			id,
			title: str(c.title) ?? 'Untitled chat',
			updatedAt: num(c.updatedAt),
			summary: str(c.summary),
			coding: parseCoding(c.coding)
		};
	}

	const data = $derived.by((): { title: string | null; chats: Chat[] } | null => {
		if (isIncomplete) return null;
		try {
			const parsed: unknown = JSON.parse(code);
			const root = rec(parsed);
			const list = Array.isArray(parsed) ? parsed : root?.chats;
			if (!Array.isArray(list)) return null;
			const chats = list.map(parseChat).filter((c): c is Chat => c !== null);
			return chats.length ? { title: str(root?.title), chats } : null;
		} catch {
			return null;
		}
	});

	const codingCount = $derived(data?.chats.filter((c) => c.coding).length ?? 0);

	const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
	const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
		['year', 365 * 24 * 3600_000],
		['month', 30 * 24 * 3600_000],
		['week', 7 * 24 * 3600_000],
		['day', 24 * 3600_000],
		['hour', 3600_000],
		['minute', 60_000]
	];
	function ago(ms: number): string {
		const diff = ms - Date.now();
		for (const [unit, size] of UNITS) {
			if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
		}
		return 'just now';
	}
</script>

<WidgetCard
	icon={MessagesSquareIcon}
	status={data ? 'ready' : isIncomplete ? 'loading' : 'error'}
	loadingLabel="Loading chats…"
	errorLabel="Could not render chats"
	skeletonClass="h-32"
	raw={code}
	title={data?.title ?? 'Chats'}
	meta={data
		? `${data.chats.length} ${data.chats.length === 1 ? 'chat' : 'chats'}${codingCount ? ` · ${codingCount} coding` : ''}`
		: null}
>
	{#if data}
		<ul class="flex flex-col gap-0.5 p-1.5">
			{#each data.chats as chat (chat.id)}
				{@const coding = chat.coding}
				{@const status = coding ? CODING_STATUS_STYLE[coding.status] : null}
				{@const note = coding?.waitingFor ?? coding?.lastError ?? null}
				<li
					class="group/chat relative flex items-start gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60"
				>
					<div
						class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover/chat:bg-background"
						aria-hidden="true"
					>
						{#if coding}
							<SquareTerminalIcon class="size-4" />
						{:else}
							<MessageSquareIcon class="size-4" />
						{/if}
					</div>
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 py-px">
						<div class="flex min-w-0 items-baseline gap-2">
							<a
								href={resolve(`/chat/${chat.id}`)}
								class="min-w-0 flex-1 truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
								title={chat.title}>{chat.title}</a
							>
							{#if chat.updatedAt !== null}
								<span class="shrink-0 text-xs text-muted-foreground tabular-nums"
									>{ago(chat.updatedAt)}</span
								>
							{/if}
						</div>
						{#if coding && status}
							<div
								class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
							>
								<span class="inline-flex shrink-0 items-center gap-1.5 {status.tone}">
									<span
										class="size-1.5 rounded-full motion-reduce:animate-none {status.dot}"
										aria-hidden="true"
									></span>
									{status.label}
								</span>
								{#if coding.project}
									<span aria-hidden="true">·</span>
									<span class="truncate">{coding.project}</span>
								{/if}
								{#if coding.branch}
									<span class="flex min-w-0 items-center gap-1">
										<GitBranchIcon class="size-3 shrink-0" aria-hidden="true" />
										<span class="truncate font-mono text-[11px]">{coding.branch}</span>
									</span>
								{/if}
								<DiffStat
									diff={{ insertions: coding.linesAdded, deletions: coding.linesRemoved }}
								/>
								{#if coding.pullRequest}
									{@const number = pullRequestNumber(coding.pullRequest)}
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										href={coding.pullRequest}
										target="_blank"
										rel="noopener noreferrer"
										class="relative z-10 inline-flex items-center gap-1 rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
										title={coding.pullRequestState
											? `Open pull request (${CODING_PR_STATE_STYLE[coding.pullRequestState].label.toLowerCase()})`
											: 'Open pull request'}
									>
										<PullRequestIcon state={coding.pullRequestState} class="size-3" />
										{number ? `PR ${number}` : 'PR'}
										{#if coding.pullRequestState}
											· {CODING_PR_STATE_STYLE[coding.pullRequestState].label}
										{/if}
									</a>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								{/if}
								{#if coding.model}
									<span class="truncate">{coding.model}</span>
								{/if}
							</div>
						{/if}
						{#if note}
							<p class="truncate text-xs {status?.tone ?? 'text-muted-foreground'}" title={note}>
								{note}
							</p>
						{/if}
						{#if chat.summary}
							<p class="line-clamp-2 text-xs text-pretty text-muted-foreground">{chat.summary}</p>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</WidgetCard>
