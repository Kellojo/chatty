<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import UsersIcon from '@lucide/svelte/icons/users';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import EmptyState from '$lib/components/app/EmptyState.svelte';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import RowMenu, { type RowMenuItem } from '$lib/components/app/settings/RowMenu.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import { skillPath, skillSourceLabel } from '$lib/skill-labels.js';
	import type { SkillSummary } from '$lib/skill-types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let toggleBusy = $state<string | null>(null);
	let deleteTarget = $state<SkillSummary | null>(null);
	let deleteBusy = $state(false);

	let importOpen = $state(false);
	let importUrl = $state('');
	let importBranch = $state('');
	let importPath = $state('');
	let importBusy = $state(false);

	let duplicateTarget = $state<SkillSummary | null>(null);
	let duplicateName = $state('');
	let duplicateBusy = $state(false);

	function shadowedVersion(skillName: string): SkillSummary | undefined {
		return data.shadowedSkills.find((s) => s.name === skillName);
	}

	let query = $state('');
	const totalSkills = $derived(data.userSkills.length + data.sharedSkills.length);

	function matches(skill: SkillSummary, q: string): boolean {
		return [skill.title, skill.name, skill.description].some((text) =>
			text.toLowerCase().includes(q)
		);
	}

	const userSkills = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return q ? data.userSkills.filter((skill) => matches(skill, q)) : data.userSkills;
	});
	const sharedSkills = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return q ? data.sharedSkills.filter((skill) => matches(skill, q)) : data.sharedSkills;
	});

	function menuItems(skill: SkillSummary): RowMenuItem[] {
		const editable = skill.scope === 'user' || data.isAdmin;
		const items: RowMenuItem[] = [
			{
				label: editable ? 'Edit' : 'View',
				icon: editable ? PencilIcon : EyeIcon,
				onSelect: () => goto(resolve(skillPath(skill)))
			},
			{
				label: skill.scope === 'shared' ? 'Duplicate to yours' : 'Duplicate',
				icon: CopyIcon,
				onSelect: () => {
					duplicateTarget = skill;
					duplicateName = `${skill.name}-copy`;
				}
			}
		];
		if (data.isAdmin && skill.scope === 'user') {
			items.push({ label: 'Share with everyone', icon: UsersIcon, onSelect: () => promote(skill) });
		}
		if (editable) {
			items.push('separator', {
				label: 'Delete',
				icon: Trash2Icon,
				destructive: true,
				onSelect: () => (deleteTarget = skill)
			});
		}
		return items;
	}

	async function toggleSkill(skill: SkillSummary, enabled: boolean) {
		if (toggleBusy) return;
		toggleBusy = `${skill.scope}:${skill.name}`;
		try {
			const res = await fetch(`/api/skills/${skill.name}?scope=${skill.scope}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? `Request failed (${res.status})`);
			}
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update skill');
		} finally {
			toggleBusy = null;
		}
	}

	async function confirmDelete() {
		if (!deleteTarget || deleteBusy) return;
		deleteBusy = true;
		try {
			const res = await fetch(`/api/skills/${deleteTarget.name}?scope=${deleteTarget.scope}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? `Request failed (${res.status})`);
			}
			toast.success('Skill deleted');
			deleteTarget = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete skill');
		} finally {
			deleteBusy = false;
		}
	}

	async function confirmImport() {
		if (importBusy || !importUrl.trim()) return;
		importBusy = true;
		try {
			const res = await fetch('/api/skills/import', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					gitUrl: importUrl.trim(),
					branch: importBranch.trim() || undefined,
					path: importPath.trim() || undefined
				})
			});
			const body = (await res.json().catch(() => null)) as {
				imported?: { name: string; action: string }[];
				skipped?: { name: string; reason: string }[];
				message?: string;
			} | null;
			if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
			const imported = body?.imported ?? [];
			const skipped = body?.skipped ?? [];
			if (imported.length > 0) {
				toast.success(`Imported ${imported.map((s) => s.name).join(', ')}`);
			}
			for (const s of skipped) {
				toast.warning(`Skipped ${s.name}: ${s.reason}`);
			}
			if (imported.length === 0 && skipped.length === 0) toast('No skills found in repo');
			importOpen = false;
			importUrl = '';
			importBranch = '';
			importPath = '';
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Import failed');
		} finally {
			importBusy = false;
		}
	}

	async function confirmDuplicate() {
		if (!duplicateTarget || duplicateBusy || !duplicateName.trim()) return;
		duplicateBusy = true;
		try {
			const res = await fetch(`/api/skills/${duplicateTarget.name}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'duplicate', newName: duplicateName.trim() })
			});
			const body = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
			toast.success(`Duplicated to ${duplicateName.trim()}`);
			duplicateTarget = null;
			duplicateName = '';
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to duplicate skill');
		} finally {
			duplicateBusy = false;
		}
	}

	async function promote(skill: SkillSummary) {
		try {
			const res = await fetch(`/api/skills/${skill.name}/promote`, { method: 'POST' });
			const body = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
			toast.success(`${skill.title} is now shared with everyone`);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to promote skill');
		}
	}
</script>

<svelte:head><title>Skills · Chatty</title></svelte:head>

{#snippet skillRow(skill: SkillSummary, canToggle: boolean)}
	{@const shadowed = skill.scope === 'user' ? shadowedVersion(skill.name) : undefined}
	<SettingsListItem
		title={skill.title}
		titleAttr={skill.name}
		href={resolve(skillPath(skill))}
		muted={!skill.enabled}
	>
		{#snippet leading()}
			{#if skill.source.startsWith('git:')}
				<GitBranchIcon class="size-4" />
			{:else}
				<SparklesIcon class="size-4" />
			{/if}
		{/snippet}
		{#snippet badges()}
			{#if skill.version}
				<span class="text-xs text-muted-foreground tabular-nums max-sm:hidden"
					>v{skill.version}</span
				>
			{/if}
			{#if shadowed}
				<Badge variant="outline" title="Used instead of the shared skill “{shadowed.title}”">
					Overrides shared
				</Badge>
			{/if}
		{/snippet}
		{#snippet meta()}
			<!-- Phones: title and a one-line description; slug and source are on the skill page. -->
			<span class="max-sm:hidden">
				<span class="font-mono">{skill.name}</span> ·
				<span title={skill.source}>{skillSourceLabel(skill)}</span>
			</span>
		{/snippet}
		{#if skill.description}
			<p
				class="line-clamp-2 text-xs text-pretty text-muted-foreground max-sm:line-clamp-1"
				title={skill.description}
			>
				{skill.description}
			</p>
		{/if}
		{#snippet trailing()}
			{#if canToggle}
				<Switch
					checked={skill.enabled}
					aria-label="Enable {skill.title}"
					disabled={toggleBusy !== null}
					onCheckedChange={(checked) => toggleSkill(skill, checked)}
				/>
			{:else if !skill.enabled}
				<!-- A locked switch reads as broken; shared skills are on unless an admin says otherwise. -->
				<Badge
					variant="outline"
					class="font-normal text-muted-foreground"
					title="Turned off for everyone by an admin"
				>
					Off
				</Badge>
			{/if}
			<RowMenu label="Actions for {skill.title}" items={menuItems(skill)} />
		{/snippet}
	</SettingsListItem>
{/snippet}

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 *:max-w-4xl md:p-6">
		<PageHeader
			title="Skills"
			icon={SparklesIcon}
			description="Instructions the AI loads when a request matches a skill's description."
		>
			{#snippet actions()}
				<!-- The empty state carries these actions until there is something listed. -->
				{#if data.userSkills.length > 0}
					<Button variant="outline" onclick={() => (importOpen = true)}>
						<GitBranchIcon class="size-4" />
						Import from git
					</Button>
					<Button href={resolve('/skills/new')}><PlusIcon class="size-4" />New skill</Button>
				{/if}
			{/snippet}
		</PageHeader>

		{#if totalSkills > 5}
			<div class="relative sm:max-w-xs">
				<SearchIcon
					class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					type="search"
					placeholder="Search skills"
					aria-label="Search skills"
					class="pl-9"
					bind:value={query}
				/>
			</div>
		{/if}

		<SettingsSection title="Your skills" flush>
			{#if data.userSkills.length === 0}
				<EmptyState
					icon={SparklesIcon}
					title="No skills of your own yet"
					description="Write one, import a repository of skills, or duplicate a shared skill to adapt it."
				>
					<Button size="sm" href={resolve('/skills/new')}
						><PlusIcon class="size-4" />New skill</Button
					>
					<Button size="sm" variant="outline" onclick={() => (importOpen = true)}>
						<GitBranchIcon class="size-4" />Import from git
					</Button>
				</EmptyState>
			{:else if userSkills.length === 0}
				<p class="px-6 py-6 text-center text-sm text-muted-foreground">
					No skills of yours match “{query.trim()}”.
				</p>
			{:else}
				<ul class="divide-y divide-border/60" aria-label="Your skills">
					{#each userSkills as skill (skill.name)}
						{@render skillRow(skill, true)}
					{/each}
				</ul>
			{/if}
		</SettingsSection>

		<SettingsSection
			title="Shared skills"
			description={data.isAdmin
				? 'Available to everyone. A skill of yours with the same name replaces it for you.'
				: 'Available to everyone and managed by admins. A skill of yours with the same name replaces it for you.'}
			flush
		>
			{#if data.sharedSkills.length === 0}
				<p class="px-6 py-6 text-center text-sm text-muted-foreground">No shared skills.</p>
			{:else if sharedSkills.length === 0}
				<p class="px-6 py-6 text-center text-sm text-muted-foreground">
					No shared skills match “{query.trim()}”.
				</p>
			{:else}
				<ul class="divide-y divide-border/60" aria-label="Shared skills">
					{#each sharedSkills as skill (skill.name)}
						{@render skillRow(skill, data.isAdmin)}
					{/each}
				</ul>
			{/if}
		</SettingsSection>

		{#if data.shadowedSkills.length > 0}
			<details class="group rounded-2xl border">
				<summary
					class="flex cursor-pointer list-none items-center gap-2 rounded-2xl px-6 py-3 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
				>
					<ChevronRightIcon class="size-4 transition-transform group-open:rotate-90" />
					{data.shadowedSkills.length} shared skill{data.shadowedSkills.length === 1 ? '' : 's'}
					replaced by yours
				</summary>
				<ul class="divide-y divide-border/60 border-t" aria-label="Replaced shared skills">
					{#each data.shadowedSkills as skill (skill.name)}
						<SettingsListItem
							title={skill.title}
							titleAttr={skill.name}
							href={resolve(skillPath(skill))}
							muted
						>
							{#snippet leading()}<SparklesIcon class="size-4" />{/snippet}
							{#snippet meta()}
								<span class="font-mono">{skill.name}</span> · {skillSourceLabel(skill)}
							{/snippet}
						</SettingsListItem>
					{/each}
				</ul>
			</details>
		{/if}
	</div>
</div>

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete skill?</Dialog.Title>
			<Dialog.Description>
				“{deleteTarget?.title}” will be permanently deleted{deleteTarget?.scope === 'shared'
					? ' for everyone'
					: ''}.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteBusy} onclick={confirmDelete}>
				{#if deleteBusy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
				Delete
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={importOpen} onOpenChange={(open) => !open && (importOpen = false)}>
	<Dialog.Content>
		<form
			class="contents"
			onsubmit={(e) => {
				e.preventDefault();
				void confirmImport();
			}}
		>
			<Dialog.Header>
				<Dialog.Title>Import skills from git</Dialog.Title>
				<Dialog.Description>
					Every folder with a skill.md in the repository is copied into your skills. Links to a
					subfolder, like github.com/user/repo/tree/main/skills, work too.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col gap-4">
				<div class="flex flex-col gap-2">
					<Label for="git-url">Repository URL</Label>
					<Input
						id="git-url"
						type="url"
						required
						placeholder="https://github.com/user/repo"
						bind:value={importUrl}
					/>
				</div>
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="flex flex-col gap-2">
						<Label for="git-branch">Branch</Label>
						<Input
							id="git-branch"
							placeholder="From the URL, or default"
							bind:value={importBranch}
						/>
					</div>
					<div class="flex flex-col gap-2">
						<Label for="git-path">Folder</Label>
						<Input id="git-path" placeholder="From the URL, or root" bind:value={importPath} />
					</div>
				</div>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (importOpen = false)}>Cancel</Button>
				<Button type="submit" disabled={importBusy || !importUrl.trim()}>
					{#if importBusy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
					Import
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={duplicateTarget !== null}
	onOpenChange={(open) => !open && (duplicateTarget = null)}
>
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
					Copy “{duplicateTarget?.title}” into your skills under a new name.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col gap-2">
				<Label for="dup-name">New name</Label>
				<Input id="dup-name" class="font-mono" required bind:value={duplicateName} />
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (duplicateTarget = null)}
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
