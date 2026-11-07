<script lang="ts">
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import { tick } from 'svelte';
	import { repositoryName } from '$lib/coding-environments.js';
	import GithubIcon from './GithubIcon.svelte';

	let {
		open = $bindable(false),
		mode = $bindable<'empty' | 'clone'>('clone'),
		environmentId,
		environmentName,
		oncreated
	}: {
		open?: boolean;
		mode?: 'empty' | 'clone';
		environmentId: string;
		environmentName: string;
		oncreated: (projectId: string) => void;
	} = $props();

	let title = $state('');
	let repository = $state('');
	let titleEdited = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	// Suggest the project name from the repository until the user types their own.
	const suggestedTitle = $derived(repositoryName(repository) ?? '');
	const effectiveTitle = $derived(mode === 'clone' && !titleEdited ? suggestedTitle : title);
	const canSubmit = $derived(
		!busy && effectiveTitle.trim().length > 0 && (mode === 'empty' || repository.trim().length > 0)
	);

	$effect(() => {
		if (open) {
			title = '';
			repository = '';
			titleEdited = false;
			error = null;
		}
	});

	async function focusField() {
		await tick();
		document.getElementById(mode === 'clone' ? 'project-repository' : 'project-title')?.focus();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!canSubmit) return;
		busy = true;
		error = null;
		try {
			const res = await fetch('/api/coding/projects', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					environmentId,
					title: effectiveTitle.trim(),
					...(mode === 'clone' ? { repository: repository.trim() } : {})
				})
			});
			const body = (await res.json().catch(() => null)) as {
				project?: { id: string; title: string };
				warning?: string;
				message?: string;
			} | null;
			if (!res.ok || !body?.project) {
				throw new Error(body?.message ?? 'Could not create the project');
			}
			if (body.warning) toast.warning(body.warning);
			else
				toast.success(
					mode === 'clone' ? `Cloned ${body.project.title}` : `Created ${body.project.title}`
				);
			open = false;
			oncreated(body.project.id);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the project';
		} finally {
			busy = false;
		}
	}
</script>

{#snippet nameField(id: string, value: string, placeholder: string)}
	<div class="grid gap-2">
		<Label for={id}>Name</Label>
		<Input
			{id}
			{value}
			oninput={(e) => {
				title = e.currentTarget.value;
				// Clearing the field brings the suggested name back.
				titleEdited = title.length > 0;
			}}
			{placeholder}
			autocomplete="off"
			disabled={busy}
		/>
	</div>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content
		class="sm:max-w-lg"
		showCloseButton={!busy}
		interactOutsideBehavior={busy ? 'ignore' : 'close'}
		escapeKeydownBehavior={busy ? 'ignore' : 'close'}
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			focusField();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>Add a project</Dialog.Title>
			<Dialog.Description>
				Projects live on {environmentName}, where the coding agent runs.
			</Dialog.Description>
		</Dialog.Header>

		<form class="grid gap-5" onsubmit={submit}>
			<Tabs.Root
				value={mode}
				onValueChange={(v) => {
					mode = v as 'empty' | 'clone';
					error = null;
					focusField();
				}}
			>
				<Tabs.List class="w-full">
					<Tabs.Trigger value="clone" disabled={busy}>
						<GithubIcon class="size-4" />
						Clone repository
					</Tabs.Trigger>
					<Tabs.Trigger value="empty" disabled={busy}>
						<FolderPlusIcon class="size-4" />
						New empty project
					</Tabs.Trigger>
				</Tabs.List>
			</Tabs.Root>

			<!-- Both panels share one grid cell, so the dialog keeps the height of the
			     taller one and doesn't jump when switching tabs. -->
			<div class="grid *:col-start-1 *:row-start-1">
				<div
					class={['grid content-start gap-5', mode !== 'clone' && 'invisible']}
					inert={mode !== 'clone'}
				>
					<div class="grid gap-2">
						<Label for="project-repository">Repository</Label>
						<Input
							id="project-repository"
							bind:value={repository}
							placeholder="owner/repo or https://github.com/owner/repo"
							autocomplete="off"
							spellcheck={false}
							disabled={busy}
						/>
						<p class="text-xs text-muted-foreground">
							{busy
								? 'Cloning can take a minute for large repositories.'
								: 'Paste a GitHub link or type owner/repo. Other git URLs work too.'}
						</p>
					</div>
					{@render nameField(
						'project-clone-title',
						titleEdited ? title : suggestedTitle,
						'Filled in from the repository'
					)}
				</div>

				<div
					class={['grid content-start gap-2', mode !== 'empty' && 'invisible']}
					inert={mode !== 'empty'}
				>
					{@render nameField('project-title', title, 'my-new-app')}
					<p class="text-xs text-muted-foreground">
						Starts as a fresh git repository with a README and a first commit.
					</p>
				</div>
			</div>

			{#if error}
				<p class="rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
					{error}
				</p>
			{/if}

			<Dialog.Footer>
				<Button type="button" variant="ghost" disabled={busy} onclick={() => (open = false)}>
					Cancel
				</Button>
				<Button type="submit" disabled={!canSubmit}>
					{#if busy}
						<LoaderCircleIcon class="size-4 animate-spin" />
						{mode === 'clone' ? 'Cloning…' : 'Creating…'}
					{:else}
						{mode === 'clone' ? 'Clone project' : 'Create project'}
					{/if}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
