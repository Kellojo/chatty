<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
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

	function sourceLabel(skill: SkillSummary): string {
		if (skill.scope === 'shared' && skill.source === 'user') return 'shared';
		return skill.source;
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
			toast.success(`Promoted ${skill.name} to shared`);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to promote skill');
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
		<div class="flex items-center justify-between">
			<h1 class="flex items-center gap-2 text-xl font-semibold">
				<SparklesIcon class="size-5" />
				Skills
			</h1>
			<div class="flex gap-2">
				<Button variant="outline" onclick={() => (importOpen = true)}>
					<GitBranchIcon class="size-4" />
					Import from git
				</Button>
				<Button href={resolve('/skills/new')}>New skill</Button>
			</div>
		</div>

		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Skill</Table.Head>
					<Table.Head>Source</Table.Head>
					<Table.Head>Scope</Table.Head>
					<Table.Head>Enabled</Table.Head>
					<Table.Head class="text-right">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.skills as skill (`${skill.scope}:${skill.name}`)}
					<Table.Row>
						<Table.Cell class="max-w-96">
							<div class="flex items-center gap-2">
								<a
									class="truncate font-medium hover:underline"
									title={skill.name}
									href={resolve(`/skills/${skill.name}?scope=${skill.scope}`)}
								>
									{skill.title}
								</a>
								{#if skill.version}
									<span class="text-xs text-muted-foreground">v{skill.version}</span>
								{/if}
							</div>
							<p class="line-clamp-2 text-sm text-muted-foreground" title={skill.description}>
								{skill.description}
							</p>
						</Table.Cell>
						<Table.Cell>
							<Badge variant="secondary" title={skill.source}>{sourceLabel(skill)}</Badge>
						</Table.Cell>
						<Table.Cell>
							<Badge variant="outline">{skill.scope}</Badge>
						</Table.Cell>
						<Table.Cell>
							<Switch
								checked={skill.enabled}
								disabled={toggleBusy !== null}
								onCheckedChange={(checked) => toggleSkill(skill, checked)}
							/>
						</Table.Cell>
						<Table.Cell class="text-right whitespace-nowrap">
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon"
											title="Actions"
											aria-label="Actions"
										>
											<EllipsisIcon class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item>
										{#snippet child({ props })}
											<a href={resolve(`/skills/${skill.name}?scope=${skill.scope}`)} {...props}>
												Edit
											</a>
										{/snippet}
									</DropdownMenu.Item>
									<DropdownMenu.Item
										onclick={() => {
											duplicateTarget = skill;
											duplicateName = `${skill.name}-copy`;
										}}
									>
										Duplicate
									</DropdownMenu.Item>
									{#if data.isAdmin && skill.scope === 'user'}
										<DropdownMenu.Item onclick={() => promote(skill)}>
											Promote to shared
										</DropdownMenu.Item>
									{/if}
									<DropdownMenu.Separator />
									<DropdownMenu.Item variant="destructive" onclick={() => (deleteTarget = skill)}>
										Delete
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={5} class="text-center text-muted-foreground">
							No skills yet. Create one or import from git.
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
</div>

<Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete skill?</Dialog.Title>
			<Dialog.Description>
				"{deleteTarget?.name}" will be permanently deleted from the {deleteTarget?.scope} bundle.
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
		<Dialog.Header>
			<Dialog.Title>Import skills from git</Dialog.Title>
			<Dialog.Description>
				Paste a repository URL — including links to a subdirectory like
				github.com/user/repo/tree/main/skills — and every skill (directory containing a skill.md)
				will be copied into your personal skills.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-col gap-3">
			<div class="flex flex-col gap-1.5">
				<Label for="git-url">Repository URL</Label>
				<Input
					id="git-url"
					placeholder="https://github.com/user/repo/tree/main/skills"
					bind:value={importUrl}
				/>
			</div>
			<div class="flex gap-3">
				<div class="flex flex-1 flex-col gap-1.5">
					<Label for="git-branch">Branch (auto-detected from URL)</Label>
					<Input id="git-branch" placeholder="main" bind:value={importBranch} />
				</div>
				<div class="flex flex-1 flex-col gap-1.5">
					<Label for="git-path">Path in repo (auto-detected from URL)</Label>
					<Input id="git-path" placeholder="skills/" bind:value={importPath} />
				</div>
			</div>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (importOpen = false)}>Cancel</Button>
			<Button disabled={importBusy || !importUrl.trim()} onclick={confirmImport}>
				{#if importBusy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
				Import
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={duplicateTarget !== null}
	onOpenChange={(open) => !open && (duplicateTarget = null)}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Duplicate skill</Dialog.Title>
			<Dialog.Description>
				Copy "{duplicateTarget?.name}" into your personal skills under a new name.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-col gap-1.5">
			<Label for="dup-name">New name</Label>
			<Input id="dup-name" bind:value={duplicateName} />
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (duplicateTarget = null)}>Cancel</Button>
			<Button disabled={duplicateBusy || !duplicateName.trim()} onclick={confirmDuplicate}>
				{#if duplicateBusy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
				Duplicate
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
