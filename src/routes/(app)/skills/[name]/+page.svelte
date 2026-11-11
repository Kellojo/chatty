<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import InfoIcon from '@lucide/svelte/icons/info';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import EnabledSwitch from '$lib/components/app/EnabledSwitch.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import ToolMultiSelect from '$lib/components/app/ToolMultiSelect.svelte';
	import FormFooter from '$lib/components/app/FormFooter.svelte';
	import { formatDateTime, formatTimeAgo } from '$lib/datetime.js';
	import { skillSourceLabel } from '$lib/skill-labels.js';
	import { guardUnsavedChanges, isSaveShortcut, missingHint } from '$lib/form-guards.js';
	import { untrack } from 'svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let title = $state('');
	let description = $state('');
	let when = $state('');
	let tools = $state<string[]>([]);
	let version = $state('');
	let toggleBusy = $state(false);
	let body = $state('');

	let busy = $state(false);
	let deleteOpen = $state(false);
	let duplicateOpen = $state(false);
	let duplicateName = $state('');
	let duplicateBusy = $state(false);

	// The fields as last saved, to tell unsaved edits apart.
	const snapshot = () => JSON.stringify([title, description, when, tools, version, body]);
	let baseline = $state('');
	const dirty = $derived(snapshot() !== baseline);
	const missing = $derived(
		missingHint([!title.trim() && 'a title', !description.trim() && 'a description'], 'save')
	);
	const canSave = $derived(data.canEdit && !busy && dirty && !missing);
	// Deleting or duplicating navigates away on purpose.
	let leaving = false;

	// SvelteKit reuses this page between skills (e.g. after Duplicate), so the
	// form starts over whenever the skill changes; saves keep the same skill.
	$effect.pre(() => {
		void data.skill.name;
		void data.scope;
		untrack(() => {
			const skill = data.skill;
			title = skill.title;
			description = skill.description;
			when = skill.frontmatter.when ?? '';
			tools = [...skill.frontmatter.tools];
			version = skill.version ?? '';
			body = skill.body;
			baseline = snapshot();
			duplicateName = `${skill.name}-copy`;
			leaving = false;
		});
	});
	guardUnsavedChanges(() => dirty && !leaving);
	let formEl = $state<HTMLFormElement | null>(null);

	function onKeydown(event: KeyboardEvent) {
		if (deleteOpen || duplicateOpen || !isSaveShortcut(event)) return;
		event.preventDefault();
		if (canSave) formEl?.requestSubmit();
	}

	function discardChanges() {
		[title, description, when, tools, version, body] = JSON.parse(baseline);
	}

	const scopeParam = $derived(data.scope === 'shared' ? '?scope=shared' : '');

	async function save() {
		if (!canSave) return;
		busy = true;
		try {
			const res = await fetch(`/api/skills/${data.skill.name}${scopeParam}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: title.trim(),
					description: description.trim(),
					when: when.trim() || null,
					tools,
					version: version.trim() || null,
					body
				})
			});
			const resData = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(resData?.message ?? `Request failed (${res.status})`);
			baseline = snapshot();
			toast.success('Skill saved');
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save skill');
		} finally {
			busy = false;
		}
	}

	// Applies right away, like the switch on the skills list; the form never sends it.
	async function setEnabled(enabled: boolean) {
		if (toggleBusy) return;
		toggleBusy = true;
		try {
			const res = await fetch(`/api/skills/${data.skill.name}${scopeParam}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
			const resData = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(resData?.message ?? `Request failed (${res.status})`);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update skill');
		} finally {
			toggleBusy = false;
		}
	}

	async function remove() {
		if (busy) return;
		busy = true;
		try {
			const res = await fetch(`/api/skills/${data.skill.name}${scopeParam}`, { method: 'DELETE' });
			if (!res.ok) {
				const resData = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(resData?.message ?? `Request failed (${res.status})`);
			}
			toast.success('Skill deleted');
			leaving = true;
			await invalidateAll();
			await goto(resolve('/skills'));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete skill');
		} finally {
			busy = false;
		}
	}

	async function confirmDuplicate() {
		if (duplicateBusy || !duplicateName.trim()) return;
		duplicateBusy = true;
		try {
			const res = await fetch(`/api/skills/${data.skill.name}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'duplicate', newName: duplicateName.trim() })
			});
			const resData = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(resData?.message ?? `Request failed (${res.status})`);
			toast.success(`Duplicated to ${duplicateName.trim()}`);
			duplicateOpen = false;
			leaving = true;
			await invalidateAll();
			await goto(resolve(`/skills/${duplicateName.trim()}`));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to duplicate skill');
		} finally {
			duplicateBusy = false;
		}
	}
</script>

<svelte:head><title>{data.skill.title} · Skills · Chatty</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto w-full max-w-6xl p-4 md:p-6">
		<div class="flex w-full max-w-4xl flex-col gap-6">
			<PageHeader title={data.skill.title} back={{ href: resolve('/skills'), label: 'Skills' }}>
				{#snippet description()}
					<span class="font-mono">{data.skill.name}</span> ·
					<span title={data.skill.source}
						>{data.scope === 'shared' && data.skill.source !== 'bundled'
							? `Shared · ${skillSourceLabel(data.skill)}`
							: data.scope === 'shared'
								? 'Built-in, shared with everyone'
								: skillSourceLabel(data.skill)}</span
					>
				{/snippet}
				{#snippet actions()}
					<EnabledSwitch
						checked={data.skill.enabled}
						disabled={toggleBusy || !data.canEdit}
						label="Enable {data.skill.title}"
						onchange={setEnabled}
					/>
					<Button variant="outline" onclick={() => (duplicateOpen = true)}>
						<CopyIcon class="size-4" />
						{data.scope === 'shared' ? 'Duplicate to yours' : 'Duplicate'}
					</Button>
					{#if data.canEdit}
						<Button
							variant="ghost"
							size="icon"
							class="text-muted-foreground hover:text-destructive"
							title="Delete skill"
							aria-label="Delete skill"
							onclick={() => (deleteOpen = true)}
						>
							<Trash2Icon class="size-4" />
						</Button>
					{/if}
				{/snippet}
			</PageHeader>

			{#if !data.canEdit}
				<p
					class="flex items-start gap-2 rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
				>
					<InfoIcon class="mt-0.5 size-4 shrink-0" />
					Shared skills are managed by admins. Duplicate it to make your own version, which then replaces
					this one for you.
				</p>
			{/if}

			<form
				bind:this={formEl}
				class="flex flex-col gap-6"
				onsubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<SettingsSection title="Details">
					<div class="grid gap-4 sm:grid-cols-[1fr_10rem]">
						<div class="flex flex-col gap-2">
							<Label for="title">Title</Label>
							<Input id="title" required bind:value={title} readonly={!data.canEdit} />
						</div>
						<div class="flex flex-col gap-2">
							<Label for="version">Version</Label>
							<Input
								id="version"
								placeholder="1.0.0"
								bind:value={version}
								readonly={!data.canEdit}
							/>
						</div>
					</div>
					<div class="flex flex-col gap-2">
						<Label for="description">Description</Label>
						<Textarea
							id="description"
							required
							rows={2}
							class="min-h-0"
							bind:value={description}
							readonly={!data.canEdit}
						/>
						<p class="text-xs text-muted-foreground">
							The AI reads this to decide when to load the skill, so say what it's for.
						</p>
					</div>
					<div class="grid gap-4 sm:grid-cols-2">
						<div class="flex flex-col gap-2">
							<Label for="when"
								>When to use <span class="text-muted-foreground">(optional)</span></Label
							>
							<Textarea
								id="when"
								rows={1}
								class="min-h-9 py-2"
								placeholder="e.g. when the user asks for a summary"
								bind:value={when}
								readonly={!data.canEdit}
							/>
						</div>
						<div class="flex flex-col gap-2">
							<Label for="tools">Expected tools</Label>
							<ToolMultiSelect
								id="tools"
								tools={data.tools}
								bind:value={tools}
								disabled={!data.canEdit}
							/>
							<p class="text-xs text-muted-foreground">Tools the instructions rely on.</p>
						</div>
					</div>
				</SettingsSection>

				<SettingsSection
					title="Instructions"
					description="Markdown the AI follows once it loads this skill."
				>
					<Textarea
						id="body"
						aria-label="Instructions"
						class="min-h-96 font-mono text-sm"
						bind:value={body}
						readonly={!data.canEdit}
					/>
					{#if data.skill.references.length > 0}
						<div class="flex flex-col gap-2 border-t border-border/60 pt-4">
							<p class="text-sm font-medium">Reference files</p>
							<ul class="flex flex-wrap gap-1.5">
								{#each data.skill.references as ref (ref)}
									<li
										class="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-mono text-xs"
									>
										<FileTextIcon class="size-3.5 text-muted-foreground" />{ref}
									</li>
								{/each}
							</ul>
							<p class="text-xs text-muted-foreground">
								Reference files sit next to skill.md on the server and can only be edited there.
							</p>
						</div>
					{/if}
				</SettingsSection>

				{#if data.canEdit}
					<FormFooter
						saveLabel="Save changes"
						{canSave}
						{busy}
						{missing}
						{dirty}
						ondiscard={discardChanges}
					/>
				{/if}
			</form>

			<SettingsSection
				title="Recent uses"
				description="Chats and agent runs that loaded this skill."
				flush
			>
				{#if data.invocations.length === 0}
					<p class="px-6 pb-4 text-sm text-muted-foreground">Not used yet.</p>
				{:else}
					<ul class="divide-y divide-border/60" aria-label="Recent uses">
						{#each data.invocations as inv (inv.id)}
							<li class="flex items-center justify-between gap-3 px-6 py-2.5 text-sm">
								{#if inv.conversation_id}
									<a
										class="truncate underline-offset-4 hover:underline"
										href={resolve(`/chat/${inv.conversation_id}`)}>Open chat</a
									>
								{:else}
									<span class="text-muted-foreground">No chat</span>
								{/if}
								<span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
									<Badge variant="secondary">{inv.triggered_by}</Badge>
									<span title={formatDateTime(inv.created_at, data.timeFormat)}
										>{formatTimeAgo(inv.created_at)}</span
									>
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</SettingsSection>
		</div>
	</div>
</div>

<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete skill?</Dialog.Title>
			<Dialog.Description>
				“{data.skill.title}” will be permanently deleted{data.scope === 'shared'
					? ' for everyone'
					: ''}.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button variant="destructive" disabled={busy} onclick={remove}>
				{#if busy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
				Delete
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={duplicateOpen}>
	<Dialog.Content>
		<form
			class="contents"
			onsubmit={(e) => {
				e.preventDefault();
				void confirmDuplicate();
			}}
		>
			<Dialog.Header>
				<Dialog.Title>Duplicate skill</Dialog.Title>
				<Dialog.Description>
					Copy “{data.skill.title}” into your skills under a new name.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col gap-2">
				<Label for="dup-name">New name</Label>
				<Input id="dup-name" class="font-mono" required bind:value={duplicateName} />
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (duplicateOpen = false)}
					>Cancel</Button
				>
				<Button type="submit" disabled={duplicateBusy || !duplicateName.trim()}>
					{#if duplicateBusy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
					Duplicate
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
