<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import XCircleIcon from '@lucide/svelte/icons/x-circle';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const SAFE_SEARCH_OPTIONS = [
		{ value: 0, label: 'Off' },
		{ value: 1, label: 'Moderate' },
		{ value: 2, label: 'Strict' }
	] as const;

	let baseUrl = $state(data.settings.baseUrl);
	let defaultLimit = $state(String(data.settings.defaultLimit));
	let timeoutMs = $state(String(data.settings.timeoutMs));
	let safeSearch = $state<0 | 1 | 2>(data.settings.safeSearch as 0 | 1 | 2);
	let language = $state(data.settings.language);

	let saveBusy = $state(false);
	let testBusy = $state(false);
	let testResult = $state<
		| { ok: true; latencyMs: number; resultCount: number }
		| { ok: false; latencyMs: number; error: string }
		| null
	>(null);

	const safeSearchLabel = $derived(
		SAFE_SEARCH_OPTIONS.find((o) => o.value === safeSearch)?.label ?? 'Moderate'
	);

	async function save() {
		if (saveBusy) return;
		const limitNum = Number(defaultLimit);
		const timeoutNum = Number(timeoutMs);
		if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 10) {
			toast.error('Default limit must be an integer between 1 and 10');
			return;
		}
		if (!Number.isInteger(timeoutNum) || timeoutNum < 1000 || timeoutNum > 60000) {
			toast.error('Timeout must be an integer between 1000 and 60000 ms');
			return;
		}
		if (baseUrl && !/^https?:\/\/.+/.test(baseUrl)) {
			toast.error('Base URL must start with http:// or https://');
			return;
		}
		saveBusy = true;
		try {
			const res = await fetch('/api/search-settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					baseUrl: baseUrl.trim(),
					defaultLimit: limitNum,
					timeoutMs: timeoutNum,
					safeSearch,
					language: language.trim() || 'auto'
				})
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			toast.success('Search settings saved');
			testResult = null;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save settings');
		} finally {
			saveBusy = false;
		}
	}

	async function testConnection() {
		if (testBusy) return;
		if (!baseUrl || !/^https?:\/\/.+/.test(baseUrl)) {
			toast.error('Enter a valid base URL first');
			return;
		}
		const timeoutNum = Number(timeoutMs) || 15000;
		testBusy = true;
		testResult = null;
		try {
			const res = await fetch('/api/search-settings/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ baseUrl: baseUrl.trim(), timeoutMs: timeoutNum })
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			testResult = (await res.json()) as
				| { ok: true; latencyMs: number; resultCount: number }
				| { ok: false; latencyMs: number; error: string };
		} catch (e) {
			testResult = {
				ok: false,
				latencyMs: 0,
				error: e instanceof Error ? e.message : 'Request failed'
			};
		} finally {
			testBusy = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-col gap-1">
		<h2 class="text-xl font-semibold">Search</h2>
		<p class="text-sm text-muted-foreground">
			Configure the web search provider used by the <code>web_search</code> tool.
		</p>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>SearXNG</Card.Title>
			<Card.Description>
				Point to your SearXNG instance. Make sure JSON output is enabled in its
				<code>settings.yml</code> (<code>search.formats: [html, json]</code>).
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="base-url">Base URL</Label>
				<Input
					id="base-url"
					type="url"
					bind:value={baseUrl}
					placeholder="https://searxng.example.com"
				/>
				<p class="text-xs text-muted-foreground">
					Leave empty to disable web search. The <code>web_search</code> tool will return a friendly error
					to the model.
				</p>
			</div>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div class="flex flex-col gap-2">
					<Label for="default-limit">Default result limit</Label>
					<Input id="default-limit" type="number" min="1" max="10" bind:value={defaultLimit} />
				</div>
				<div class="flex flex-col gap-2">
					<Label for="timeout">Timeout (ms)</Label>
					<Input
						id="timeout"
						type="number"
						min="1000"
						max="60000"
						step="500"
						bind:value={timeoutMs}
					/>
				</div>
			</div>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div class="flex flex-col gap-2">
					<Label>Safe search</Label>
					<Select.Root
						type="single"
						value={String(safeSearch)}
						onValueChange={(v) => (safeSearch = Number(v) as 0 | 1 | 2)}
					>
						<Select.Trigger class="w-full">{safeSearchLabel}</Select.Trigger>
						<Select.Content>
							{#each SAFE_SEARCH_OPTIONS as option (option.value)}
								<Select.Item value={String(option.value)}>{option.label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="language">Language</Label>
					<Input id="language" bind:value={language} placeholder="auto" maxlength={20} />
					<p class="text-xs text-muted-foreground">
						Use <code>auto</code> or a BCP-47 code like <code>en</code> or <code>de</code>.
					</p>
				</div>
			</div>

			{#if testResult}
				<div
					class="flex items-start gap-2 rounded-md border p-3 text-sm {testResult.ok
						? 'border-success/40 bg-success/10 text-success-foreground'
						: 'border-destructive/40 bg-destructive/10 text-destructive'}"
				>
					{#if testResult.ok}
						<CheckCircle2Icon class="mt-0.5 size-4 shrink-0" />
						<span>
							Connected in {testResult.latencyMs} ms — {testResult.resultCount} sample results returned.
						</span>
					{:else}
						<XCircleIcon class="mt-0.5 size-4 shrink-0" />
						<span>
							Connection failed{testResult.latencyMs ? ` after ${testResult.latencyMs} ms` : ''}:
							{testResult.error}
						</span>
					{/if}
				</div>
			{/if}

			<div class="flex justify-end gap-2">
				<Button variant="outline" onclick={testConnection} disabled={testBusy || !baseUrl}>
					{#if testBusy}
						<Loader2Icon class="size-4 animate-spin" />
						Testing…
					{:else}
						Test connection
					{/if}
				</Button>
				<Button onclick={save} disabled={saveBusy}>
					{saveBusy ? 'Saving…' : 'Save'}
				</Button>
			</div>
		</Card.Content>
	</Card.Root>
</div>
