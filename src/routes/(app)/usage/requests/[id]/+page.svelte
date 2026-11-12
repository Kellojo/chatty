<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { formatDateTime } from '$lib/datetime.js';
	import { formatCount, formatLatency } from '$lib/formats.js';
	import { billedParts } from '$lib/components/app/usage/usage.js';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import type { ProxyRequestStatus } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const request = $derived(data.request);
	const billed = $derived(billedParts(request.costUsd, { precise: true }));
	const sourceLabel = $derived(request.source.charAt(0).toUpperCase() + request.source.slice(1));

	onMount(() => {
		return onServerEvent((event) => {
			if (event.type !== 'proxy.request.started' && event.type !== 'proxy.request.finished') {
				return;
			}
			if (event.requestId !== request.id) return;
			void invalidateAll();
		});
	});

	function statusTone(status: ProxyRequestStatus): string {
		if (status === 'running') return 'border-info/40 text-info-foreground';
		if (status === 'complete') return 'border-success/30 text-success-foreground';
		return 'border-destructive/30 text-destructive';
	}

	function statusDot(status: ProxyRequestStatus): string {
		if (status === 'running') return 'bg-info animate-pulse';
		if (status === 'complete') return 'bg-success';
		return 'bg-destructive';
	}
</script>

<svelte:head><title>Request · Usage · Chatty</title></svelte:head>

<div class="flex flex-col gap-4">
	<div class="flex flex-col gap-1">
		<Breadcrumb.Root>
			<Breadcrumb.List>
				<Breadcrumb.Item>
					<Breadcrumb.Link href={resolve('/usage/requests')}>Requests</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator />
				<Breadcrumb.Item>
					<Breadcrumb.Page>{request.id.slice(0, 8)}…</Breadcrumb.Page>
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>
		<div class="flex flex-wrap items-center gap-2">
			<h2 class="text-xl font-semibold">
				{sourceLabel} request
			</h2>
			<Badge variant="outline">{request.source}</Badge>
			{#if request.purpose === 'title'}
				<Badge variant="outline">title</Badge>
			{/if}
			<span
				class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium {statusTone(
					request.status
				)}"
			>
				<span class="size-1.5 rounded-full {statusDot(request.status)}"></span>
				{request.status}
			</span>
		</div>
	</div>

	{#if request.error}
		<div
			class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm whitespace-pre-wrap text-destructive"
		>
			{request.error}
		</div>
	{/if}

	<!-- Cards size to their content rather than stretching to the tallest. -->
	<div class="grid items-start gap-4 lg:grid-cols-2">
		<Card.Root>
			<Card.Header>
				<Card.Title>Summary</Card.Title>
			</Card.Header>
			<Card.Content>
				<dl
					class="grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[auto_1fr] sm:gap-y-2 max-sm:[&>dt:not(:first-child)]:mt-3"
				>
					<dt class="text-muted-foreground">ID</dt>
					<dd class="font-mono text-xs break-all select-all" title="Select to copy">
						{request.id}
					</dd>
					<dt class="text-muted-foreground">Endpoint</dt>
					<dd>
						<span
							class="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-xs"
						>
							{request.endpoint}
						</span>
					</dd>
					<dt class="text-muted-foreground">Started</dt>
					<dd>{formatDateTime(request.startedAt, data.timeFormat)}</dd>
					<dt class="text-muted-foreground">Latency</dt>
					<dd>{formatLatency(request.latencyMs)}</dd>
					<dt class="text-muted-foreground">Requested model</dt>
					<dd>{request.requestedModel}</dd>
					<dt class="text-muted-foreground">Served provider / model</dt>
					<dd>
						{#if request.providerId || request.modelId}
							<span title={request.providerId ?? undefined}
								>{data.providerName ?? request.providerId ?? '—'}</span
							>
							/ {request.modelId ?? '—'}
						{:else}
							—
						{/if}
					</dd>
					{#if data.mappingName}
						<dt class="text-muted-foreground">Mapping</dt>
						<dd>{data.mappingName}</dd>
					{/if}
					{#if request.fallbackIndex > 0}
						<dt class="text-muted-foreground">Fallback index</dt>
						<dd>{request.fallbackIndex}</dd>
					{/if}
					{#if request.stepIndex > 0 || request.source !== 'proxy'}
						<dt class="text-muted-foreground">Step</dt>
						<!-- Stored zero-based; people count steps from one. -->
						<dd>{request.stepIndex + 1}</dd>
					{/if}
					{#if request.conversationId}
						<dt class="text-muted-foreground">Conversation</dt>
						<dd class="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span class="font-mono text-xs select-all" title={request.conversationId}>
								{request.conversationId.slice(0, 8)}…
							</span>
							<!-- Only link to conversations the viewer can actually open. -->
							{#if data.conversationOpenable}
								<a
									class="text-sm text-primary underline-offset-4 hover:underline"
									href={resolve(`/chat/${request.conversationId}`)}
								>
									Open conversation
								</a>
							{:else}
								<span class="text-xs text-muted-foreground"> (another user's conversation) </span>
							{/if}
						</dd>
					{/if}
					{#if request.runId}
						<dt class="text-muted-foreground">Agent run</dt>
						<dd class="font-mono text-xs">{request.runId.slice(0, 8)}…</dd>
					{/if}
					<dt class="text-muted-foreground">Stream</dt>
					<dd>{request.stream ? 'Yes' : 'No'}</dd>
					{#if request.source === 'proxy'}
						<dt class="text-muted-foreground">HTTP status</dt>
						<dd>{request.httpStatus ?? '—'}</dd>
					{/if}
					<dt class="text-muted-foreground">User</dt>
					<dd>{data.userName}</dd>
					{#if request.source === 'proxy'}
						<dt class="text-muted-foreground">API key</dt>
						<dd>{data.keyLabel ?? '—'}</dd>
					{/if}
				</dl>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Usage</Card.Title>
			</Card.Header>
			<Card.Content>
				<dl
					class="grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[auto_1fr] sm:gap-y-2 max-sm:[&>dt:not(:first-child)]:mt-3"
				>
					<dt class="text-muted-foreground">Input tokens</dt>
					<dd>{request.inputTokens === null ? '—' : formatCount(request.inputTokens)}</dd>
					<!-- Part of the input tokens, priced separately when a cache price is set. -->
					{#if request.cacheReadTokens}
						<dt class="text-muted-foreground">Read from cache</dt>
						<dd>{formatCount(request.cacheReadTokens)} of the input tokens</dd>
					{/if}
					{#if request.cacheWriteTokens}
						<dt class="text-muted-foreground">Written to cache</dt>
						<dd>{formatCount(request.cacheWriteTokens)} of the input tokens</dd>
					{/if}
					<dt class="text-muted-foreground">Output tokens</dt>
					<dd>{request.outputTokens === null ? '—' : formatCount(request.outputTokens)}</dd>
					<dt class="text-muted-foreground">Billed</dt>
					<dd>
						{billed.value}
						{#if billed.note}
							<span class="ml-1 text-muted-foreground">{billed.note}</span>
						{/if}
					</dd>
				</dl>
			</Card.Content>
		</Card.Root>
	</div>
</div>
