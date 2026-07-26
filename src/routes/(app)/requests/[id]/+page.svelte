<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { formatDateTime } from '$lib/datetime.js';
	import { formatCount, formatCost } from '$lib/formats.js';
	import { onServerEvent } from '$lib/state/events.svelte.js';
	import type { ProxyRequestStatus } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const request = $derived(data.request);

	onMount(() => {
		return onServerEvent((event) => {
			if (event.type !== 'proxy.request.started' && event.type !== 'proxy.request.finished') {
				return;
			}
			if (event.requestId !== request.id) return;
			void invalidateAll();
		});
	});

	function statusVariant(status: ProxyRequestStatus): 'outline' | 'secondary' | 'destructive' {
		if (status === 'running') return 'outline';
		if (status === 'complete') return 'secondary';
		return 'destructive';
	}

	function statusClass(status: ProxyRequestStatus): string {
		if (status === 'running') return 'border-info/50 text-info-foreground';
		if (status === 'complete') return 'text-success-foreground';
		return '';
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
		<div class="flex flex-col gap-1">
			<Breadcrumb.Root>
				<Breadcrumb.List>
					<Breadcrumb.Item>
						<Breadcrumb.Link href={resolve('/requests')}>Requests</Breadcrumb.Link>
					</Breadcrumb.Item>
					<Breadcrumb.Separator />
					<Breadcrumb.Item>
						<Breadcrumb.Page>{request.id.slice(0, 8)}…</Breadcrumb.Page>
					</Breadcrumb.Item>
				</Breadcrumb.List>
			</Breadcrumb.Root>
			<div class="flex flex-wrap items-center gap-2">
				<h1 class="text-xl font-semibold">
					{request.source === 'proxy' ? 'Proxy request' : `${request.source} request`}
				</h1>
				<Badge variant="outline">{request.source}</Badge>
				{#if request.purpose === 'title'}
					<Badge variant="outline">title</Badge>
				{/if}
				<Badge variant={statusVariant(request.status)} class={statusClass(request.status)}>
					{#if request.status === 'running'}
						<span class="size-2 animate-pulse rounded-full bg-info"></span>
					{/if}
					{request.status}
				</Badge>
			</div>
		</div>

		{#if request.error}
			<div
				class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm whitespace-pre-wrap text-destructive"
			>
				{request.error}
			</div>
		{/if}

		<div class="grid gap-4 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>Summary</Card.Title>
				</Card.Header>
				<Card.Content>
					<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
						<dt class="text-muted-foreground">ID</dt>
						<dd class="font-mono text-xs">{request.id}</dd>
						<dt class="text-muted-foreground">Endpoint</dt>
						<dd><Badge variant="secondary">{request.endpoint}</Badge></dd>
						<dt class="text-muted-foreground">Requested model</dt>
						<dd>{request.requestedModel}</dd>
						<dt class="text-muted-foreground">Served provider / model</dt>
						<dd>
							{#if request.providerId || request.modelId}
								{request.providerId ?? '—'} / {request.modelId ?? '—'}
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
							<dd>{request.stepIndex}</dd>
						{/if}
						{#if request.conversationId}
							<dt class="text-muted-foreground">Conversation</dt>
							<dd>
								<a
									class="font-mono text-xs text-primary underline-offset-4 hover:underline"
									href={resolve(`/chat/${request.conversationId}`)}
								>
									{request.conversationId.slice(0, 8)}…
								</a>
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
					<Card.Title>Timing</Card.Title>
				</Card.Header>
				<Card.Content>
					<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
						<dt class="text-muted-foreground">Started</dt>
						<dd>{formatDateTime(request.startedAt, data.timeFormat)}</dd>
						<dt class="text-muted-foreground">Latency</dt>
						<dd>{request.latencyMs !== null ? `${request.latencyMs} ms` : '—'}</dd>
					</dl>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Usage</Card.Title>
				</Card.Header>
				<Card.Content>
					<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
						<dt class="text-muted-foreground">Input tokens</dt>
						<dd>{request.inputTokens === null ? '—' : formatCount(request.inputTokens)}</dd>
						<dt class="text-muted-foreground">Output tokens</dt>
						<dd>{request.outputTokens === null ? '—' : formatCount(request.outputTokens)}</dd>
						<dt class="text-muted-foreground">Cost</dt>
						<dd>
							{#if request.costUsd !== null}
								{formatCost(request.costUsd)}
							{:else}
								—
								<span class="text-muted-foreground">(model prices unknown)</span>
							{/if}
						</dd>
					</dl>
				</Card.Content>
			</Card.Root>

			{#if request.compression}
				<Card.Root>
					<Card.Header>
						<Card.Title>Compression</Card.Title>
					</Card.Header>
					<Card.Content>
						<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
							{#if request.compression.caveman}
								<dt class="text-muted-foreground">Caveman level</dt>
								<dd>{request.compression.caveman.level}</dd>
								<dt class="text-muted-foreground">Caveman saved (est.)</dt>
								<dd>
									{#if request.compression.caveman.estSaved !== null}
										{formatCount(request.compression.caveman.estSaved)} tokens
									{:else}
										—
									{/if}
								</dd>
								{#if request.compression.caveman.overhead !== undefined}
									<dt class="text-muted-foreground">Caveman overhead</dt>
									<dd>{formatCount(request.compression.caveman.overhead)} input tokens</dd>
								{/if}
								{#if request.compression.caveman.basis}
									<dt class="text-muted-foreground">Caveman estimate basis</dt>
									<dd>{request.compression.caveman.basis}</dd>
								{/if}
							{/if}
						</dl>
					</Card.Content>
				</Card.Root>
			{/if}
		</div>
	</div>
</div>
