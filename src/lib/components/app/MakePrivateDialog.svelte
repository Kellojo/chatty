<script lang="ts">
	import { toast } from 'svelte-sonner';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import LockIcon from '@lucide/svelte/icons/lock';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { Conversation } from '$lib/types.js';

	/**
	 * Confirms making existing chats private (design 2.5): what already left
	 * can't be recalled, so it offers what can still be tidied up: the title
	 * (written by the title model, maybe in push history) and memory notes
	 * written from the chats (best effort, from the memory audit log).
	 */
	let {
		targets,
		admin = false,
		onclose,
		ondone
	}: {
		/** The chats to make private; the dialog is open while set. */
		targets: Pick<Conversation, 'id' | 'title'>[] | null;
		/** Admins may also mark shared notes private. */
		admin?: boolean;
		onclose: () => void;
		/** After the change: the chats now private, and the updated chat when there was one. */
		ondone: (result: { ids: string[]; conversation?: Conversation }) => void;
	} = $props();

	type DerivedConcept = { scope: 'user' | 'shared'; path: string; title: string; private: boolean };

	let replaceTitle = $state(false);
	let markConcepts = $state(true);
	let saving = $state(false);
	/** Concepts written from these chats; null while loading. */
	let concepts = $state<DerivedConcept[] | null>(null);
	let conceptsFailed = $state(false);

	const single = $derived(targets?.length === 1);
	const pending = $derived((concepts ?? []).filter((c) => !c.private));
	// Shared notes are admin-only: others see them listed, but they stay as they are.
	const markable = $derived(pending.filter((c) => c.scope === 'user' || admin));
	const lockedShared = $derived(pending.length - markable.length);

	// Keyed by the ids, so a refreshed (but equal) list of targets doesn't start over.
	const targetKey = $derived(targets?.map((t) => t.id).join('\n') ?? '');
	let loadSeq = 0;
	$effect(() => {
		if (!targetKey) return;
		const ids = targetKey.split('\n');
		replaceTitle = false;
		markConcepts = true;
		concepts = null;
		conceptsFailed = false;
		const seq = ++loadSeq;
		void loadConcepts(ids).then((found) => {
			if (seq !== loadSeq) return;
			if (found) concepts = found;
			else {
				concepts = [];
				conceptsFailed = true;
			}
		});
	});

	async function loadConcepts(ids: string[]): Promise<DerivedConcept[] | null> {
		const lists = await Promise.all(
			ids.map(async (id) => {
				const res = await fetch(`/api/conversations/${id}/derived-concepts`).catch(() => null);
				if (!res?.ok) return null;
				return ((await res.json()) as { concepts: DerivedConcept[] }).concepts;
			})
		);
		if (lists.some((l) => l === null)) return null;
		// A throwaway set for deduplicating one result, not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const seen = new Set<string>();
		return lists
			.flat()
			.filter((c): c is DerivedConcept => c !== null)
			.filter((c) => {
				const key = `${c.scope}:${c.path}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
	}

	async function errorMessage(res: Response | null, fallback: string): Promise<string> {
		const data = (await res?.json().catch(() => null)) as { message?: string } | null;
		return data?.message ?? fallback;
	}

	/** Marks the listed notes private; returns how many changed, or null when it failed. */
	async function markPrivate(list: DerivedConcept[]): Promise<number | null> {
		let updated = 0;
		for (const scope of ['user', 'shared'] as const) {
			const paths = list.filter((c) => c.scope === scope).map((c) => c.path);
			if (paths.length === 0) continue;
			const res = await fetch('/api/memory/private', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scope, paths, private: true })
			}).catch(() => null);
			if (!res?.ok) return null;
			updated += ((await res.json()) as { updated: number }).updated;
		}
		return updated;
	}

	async function confirm() {
		if (!targets?.length || saving) return;
		saving = true;
		try {
			let result: { ids: string[]; conversation?: Conversation };
			if (single) {
				const res = await fetch(`/api/conversations/${targets[0].id}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ private: true, ...(replaceTitle ? { replaceTitle: true } : {}) })
				}).catch(() => null);
				if (!res?.ok) {
					toast.error(await errorMessage(res, 'Failed to make the chat private'));
					return;
				}
				const { conversation } = (await res.json()) as { conversation: Conversation };
				result = { ids: [conversation.id], conversation };
			} else {
				const res = await fetch('/api/conversations/private', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						ids: targets.map((t) => t.id),
						...(replaceTitle ? { replaceTitle: true } : {})
					})
				}).catch(() => null);
				if (!res?.ok) {
					toast.error(await errorMessage(res, 'Failed to make the chats private'));
					return;
				}
				result = { ids: ((await res.json()) as { updated: string[] }).updated };
			}
			const count = result.ids.length;
			toast.success(
				single
					? 'This chat is now private'
					: `${count} ${count === 1 ? 'chat is' : 'chats are'} now private`
			);
			if (markConcepts && markable.length > 0) {
				const marked = await markPrivate(markable);
				if (marked === null) toast.error("Couldn't mark the memory notes private");
				else if (marked > 0) {
					toast.success(`${marked} memory ${marked === 1 ? 'note' : 'notes'} marked private`);
				}
			}
			ondone(result);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root open={targets !== null} onOpenChange={(open) => !open && !saving && onclose()}>
	<Dialog.Content class="max-h-[calc(100dvh-2rem)] overflow-y-auto">
		<Dialog.Header>
			<Dialog.Title>
				{single ? 'Make this chat private?' : `Make ${targets?.length ?? 0} chats private?`}
			</Dialog.Title>
			<Dialog.Description>
				From now on only models trusted with private data see {single
					? 'this chat'
					: 'these chats'}, and tools that send data outside Chatty are off.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-4">
			<div class="flex items-start justify-between gap-4">
				<span class="flex flex-col gap-0.5">
					<Label for="make-private-title">Replace the title with a placeholder</Label>
					<span class="text-xs text-muted-foreground">
						The current {single ? 'title was' : 'titles were'} written by a title model and may be in
						push notification history.
					</span>
				</span>
				<Switch id="make-private-title" class="mt-0.5" bind:checked={replaceTitle} />
			</div>

			<div class="flex flex-col gap-3">
				<p class="text-sm font-medium">
					Memory written from {single ? 'this chat' : 'these chats'}
				</p>
				{#if concepts === null}
					<p class="flex items-center gap-2 text-xs text-muted-foreground">
						<LoaderCircleIcon class="size-3.5 animate-spin" aria-hidden="true" />
						Looking for memory notes…
					</p>
				{:else if conceptsFailed}
					<p class="text-xs text-muted-foreground">Couldn't look up memory notes.</p>
				{:else if concepts.length === 0}
					<p class="text-xs text-muted-foreground">No memory notes were written from it.</p>
				{:else}
					<ul
						class="flex max-h-40 flex-col divide-y divide-border/60 overflow-y-auto rounded-md border"
						aria-label="Memory notes"
					>
						{#each concepts as concept (`${concept.scope}:${concept.path}`)}
							<li class="flex items-center gap-2 px-3 py-1.5">
								<span class="min-w-0 flex-1 truncate" title={concept.path}>{concept.title}</span>
								{#if concept.scope === 'shared'}
									<span class="shrink-0 text-xs text-muted-foreground">Shared</span>
								{/if}
								{#if concept.private}
									<span
										class="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
									>
										<LockIcon class="size-3" aria-hidden="true" />Already private
									</span>
								{/if}
							</li>
						{/each}
					</ul>
					{#if markable.length > 0}
						<div class="flex items-start justify-between gap-4">
							<span class="flex flex-col gap-0.5">
								<Label for="make-private-notes">Mark these private too</Label>
								<span class="text-xs text-muted-foreground">
									Best effort: these were written after a memory run read {single
										? 'this chat'
										: 'these chats'}. The same facts may also be in other notes.
								</span>
							</span>
							<Switch id="make-private-notes" class="mt-0.5" bind:checked={markConcepts} />
						</div>
					{/if}
					{#if lockedShared > 0}
						<p class="text-xs text-muted-foreground">
							Only an admin can mark shared notes private.
						</p>
					{/if}
				{/if}
			</div>

			<p
				class="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-sm font-normal text-amber-800 dark:bg-amber-400/10 dark:text-amber-200/90"
				role="note"
			>
				<ShieldAlertIcon class="mt-px size-4 shrink-0" aria-hidden="true" />
				<span>
					Anything already sent to models can't be recalled, and push notifications already sent
					(with their titles) can't be cleared.
				</span>
			</p>
		</div>

		<Dialog.Footer>
			<Button variant="outline" disabled={saving} onclick={onclose}>Cancel</Button>
			<Button disabled={saving} onclick={confirm}>
				{saving ? 'Making private…' : 'Make private'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
