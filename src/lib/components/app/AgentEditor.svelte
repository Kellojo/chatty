<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import ModelSelect from '$lib/components/app/ModelSelect.svelte';
	import CodingContextBar from '$lib/components/app/CodingContextBar.svelte';
	import CodingModelSelect from '$lib/components/app/CodingModelSelect.svelte';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { untrack } from 'svelte';
	import { CodingTaskState } from '$lib/state/coding-task.svelte.js';
	import type { CodingEnvironment } from '$lib/coding-environments.js';
	import type {
		Agent,
		AgentEventName,
		AgentTriggerType,
		ModelMapping,
		ModelsByProvider
	} from '$lib/types.js';
	import { AGENT_EVENT_NAMES } from '$lib/types.js';

	interface ToolInfo {
		name: string;
		description: string;
		server: string;
	}

	let {
		agent,
		groups,
		mappings = [],
		tools,
		codingEnvironments = [],
		readonly = false
	}: {
		agent: Agent | null;
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		tools: ToolInfo[];
		codingEnvironments?: CodingEnvironment[];
		readonly?: boolean;
	} = $props();

	const allTriggerTypes: AgentTriggerType[] = ['persona', 'schedule', 'http', 'manual', 'event'];

	// Coding agents: each run is a T3 coding task with the saved target. Built-in
	// agents never are, and the option only shows when there is somewhere to run.
	// svelte-ignore state_referenced_locally
	const savedTarget = agent?.codingTarget ?? null;
	// svelte-ignore state_referenced_locally
	const canCode = !readonly && (codingEnvironments.length > 0 || savedTarget !== null);
	// svelte-ignore state_referenced_locally
	const targetEnvironmentMissing =
		savedTarget !== null && !codingEnvironments.some((e) => e.id === savedTarget.environmentId);
	let runsOn = $state<'model' | 'coding'>(savedTarget ? 'coding' : 'model');
	const coding = $derived(runsOn === 'coding');
	const codingTask = new CodingTaskState(
		untrack(() => codingEnvironments),
		{ initial: savedTarget, remember: false }
	);
	let codingInitialized = false;
	$effect(() => {
		if (coding && !codingInitialized) {
			codingInitialized = true;
			untrack(() => codingTask.init());
		}
	});

	const triggerTypes = $derived(
		coding ? allTriggerTypes.filter((t) => t !== 'persona') : allTriggerTypes
	);

	function setRunsOn(value: 'model' | 'coding') {
		runsOn = value;
		if (value === 'coding' && form.triggerType === 'persona') form.triggerType = 'manual';
	}

	const triggerLabels: Record<AgentTriggerType, string> = {
		persona: 'Persona (chat)',
		schedule: 'Schedule',
		http: 'HTTP',
		manual: 'Manual',
		event: 'Event'
	};

	const eventLabels: Record<AgentEventName, string> = {
		'memory.changed': 'Memory created/updated/deleted',
		'chat.created': 'Chat created',
		'chat.message_completed': 'Chat message completed',
		'skill.created': 'Skill created',
		'skill.updated': 'Skill updated',
		'skill.deleted': 'Skill deleted',
		'coding.thread.finished': 'Coding task finished'
	};

	// svelte-ignore state_referenced_locally
	let form = $state({
		name: agent?.name ?? '',
		description: agent?.description ?? '',
		systemPrompt: agent?.systemPrompt ?? '',
		modelValue: agent?.providerId && agent?.modelId ? `${agent.providerId}/${agent.modelId}` : '',
		triggerType: (agent?.triggerType ?? 'manual') as AgentTriggerType,
		cron: agent?.triggerConfig.cron ?? '',
		event: (agent?.triggerConfig.event ?? 'skill.created') as AgentEventName,
		every: String(agent?.triggerConfig.every ?? 1) as string | number,
		instructions: agent?.triggerConfig.instructions ?? '',
		restrictTools: agent?.toolAllowlist != null,
		allowlist: [...(agent?.toolAllowlist ?? [])],
		maxSteps: (agent?.maxSteps?.toString() ?? '') as string | number,
		enabled: agent?.enabled ?? true
	});

	let busy = $state(false);

	const toolGroups = $derived.by(() => {
		const groups: { server: string; tools: ToolInfo[] }[] = [];
		for (const tool of tools) {
			const group = groups.find((g) => g.server === tool.server);
			if (group) group.tools.push(tool);
			else groups.push({ server: tool.server, tools: [tool] });
		}
		return groups;
	});

	function toggleTool(name: string, checked: boolean) {
		form.allowlist = checked ? [...form.allowlist, name] : form.allowlist.filter((n) => n !== name);
	}

	async function save() {
		if (busy || !form.name.trim() || !form.systemPrompt.trim()) return;
		const draft = codingTask.draft;
		if (coding && !draft) {
			toast.error(codingTask.blocker ?? 'Choose where the coding agent runs');
			return;
		}
		const maxStepsRaw = String(form.maxSteps ?? '').trim();
		let maxSteps: number | null = null;
		if (maxStepsRaw !== '') {
			maxSteps = Number(maxStepsRaw);
			if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) {
				toast.error('Max steps must be an integer between 1 and 100');
				return;
			}
		}
		let every: number | null = null;
		if (form.triggerType === 'event') {
			every = Number(String(form.every ?? '').trim());
			if (!Number.isInteger(every) || every < 1 || every > 1000) {
				toast.error('Occurrence interval must be an integer between 1 and 1000');
				return;
			}
		}
		busy = true;
		try {
			const [providerId, ...rest] = form.modelValue.split('/');
			const body = {
				name: form.name.trim(),
				description: form.description.trim(),
				systemPrompt: form.systemPrompt,
				providerId: form.modelValue ? providerId : null,
				modelId: form.modelValue ? rest.join('/') : null,
				skillNames: agent?.skillNames ?? [],
				toolAllowlist: form.restrictTools ? form.allowlist : null,
				triggerType: form.triggerType,
				triggerConfig:
					form.triggerType === 'schedule'
						? { cron: form.cron.trim() }
						: form.triggerType === 'persona'
							? {}
							: form.triggerType === 'event'
								? {
										event: form.event,
										every: every ?? 1,
										...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {})
									}
								: { instructions: form.instructions.trim() },
				maxSteps,
				enabled: form.enabled,
				codingTarget:
					coding && draft
						? { ...draft, baseBranch: draft.baseBranch ?? null }
						: savedTarget
							? null
							: undefined
			};
			const res = await fetch(agent ? `/api/agents/${agent.id}` : '/api/agents', {
				method: agent ? 'PATCH' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			if (agent) {
				toast.success('Agent saved');
				await goto(resolve('/agents'));
			} else {
				toast.success('Agent created');
				await goto(resolve('/agents'));
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save agent');
		} finally {
			busy = false;
		}
	}
</script>

{#snippet required()}
	<span class="text-destructive">*</span>
{/snippet}

<div class="flex flex-col gap-4">
	{#if canCode}
		<Card.Root>
			<Card.Header>
				<Card.Title>Runs on</Card.Title>
				<Card.Description>
					A Chatty model with Chatty's tools, or a coding agent working in a repository on a T3 Code
					environment.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Runs on">
					{#each [{ value: 'model', label: 'Chatty model' }, { value: 'coding', label: 'Coding agent (T3 Code)' }] as const as option (option.value)}
						<button
							type="button"
							role="radio"
							aria-checked={runsOn === option.value}
							class="rounded px-3 py-1.5 text-sm transition-colors {runsOn === option.value
								? 'bg-secondary font-medium text-secondary-foreground'
								: 'text-muted-foreground hover:text-foreground'}"
							onclick={() => setRunsOn(option.value)}
						>
							{option.label}
						</button>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>Basics</Card.Title>
			<Card.Description>Name, description, and the instructions the agent follows.</Card.Description
			>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="agent-name">Name {@render required()}</Label>
				<Input
					id="agent-name"
					bind:value={form.name}
					maxlength={100}
					disabled={readonly}
					placeholder="Research assistant"
				/>
			</div>
			<div class="flex flex-col gap-2">
				<Label for="agent-description">Description</Label>
				<Input
					id="agent-description"
					bind:value={form.description}
					maxlength={500}
					disabled={readonly}
					placeholder="What this agent does"
				/>
			</div>
			<div class="flex flex-col gap-2">
				<Label for="agent-system-prompt">
					{coding ? 'Task' : 'System prompt'}
					{@render required()}
				</Label>
				<Textarea
					id="agent-system-prompt"
					bind:value={form.systemPrompt}
					rows={8}
					disabled={readonly}
					placeholder={coding
						? 'Update outdated dependencies, run the tests and open a pull request.'
						: 'You are…'}
				/>
				{#if coding}
					<p class="text-sm text-muted-foreground">
						Sent to the coding agent as the first message of every run, followed by the run's
						instructions.
					</p>
				{/if}
			</div>
		</Card.Content>
	</Card.Root>

	{#if coding}
		<Card.Root>
			<Card.Header>
				<Card.Title>Coding target</Card.Title>
				<Card.Description>Where each run starts a coding task.</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				{#if targetEnvironmentMissing}
					<p class="text-sm text-destructive">
						The coding environment this agent ran on was removed or disabled. Runs fail until you
						choose another one.
					</p>
				{/if}
				<div class="flex flex-wrap items-center gap-2">
					<CodingModelSelect state={codingTask} disabled={readonly || busy} />
					<CodingContextBar state={codingTask} disabled={readonly || busy} />
				</div>
				{#if !codingTask.draft && codingTask.blocker}
					<p class="text-sm text-muted-foreground">{codingTask.blocker}</p>
				{/if}
				<p class="text-sm text-muted-foreground">
					Runs start without anyone watching. With <span class="font-medium">Ask first</span>
					the run waits for your approval inside its coding task before running commands or editing.
				</p>
				{#if codingTask.autonomy === 'full-access'}
					<p class="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
						<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
						Full access never asks: every run can run any command and change any file in the project without
						your approval.
					</p>
				{/if}
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>Model</Card.Title>
				<Card.Description>Which model the agent runs on.</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div class="flex flex-col gap-2">
					<Label>Model</Label>
					<ModelSelect
						{groups}
						{mappings}
						bind:value={form.modelValue}
						onselect={() => {}}
						disabled={readonly}
						noneValue=""
						noneLabel="Default chat model"
						class="w-full"
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="agent-max-steps">Max steps</Label>
					<Input
						id="agent-max-steps"
						type="number"
						min={1}
						max={100}
						bind:value={form.maxSteps}
						placeholder="25 (default)"
						disabled={readonly}
					/>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>Trigger</Card.Title>
			<Card.Description>How this agent gets started.</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label>Trigger type</Label>
				<Select.Root type="single" bind:value={form.triggerType} disabled={readonly}>
					<Select.Trigger class="w-full">
						{triggerLabels[form.triggerType]}
					</Select.Trigger>
					<Select.Content>
						{#each triggerTypes as option (option)}
							<Select.Item value={option}>{triggerLabels[option]}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			{#if form.triggerType === 'schedule'}
				<div class="flex flex-col gap-2">
					<Label for="agent-cron">Cron schedule {@render required()}</Label>
					<Input
						id="agent-cron"
						bind:value={form.cron}
						disabled={readonly}
						placeholder="*/30 * * * *"
					/>
					<p class="text-sm text-muted-foreground">5-field cron in server TZ (e.g. */30 * * * *)</p>
				</div>
			{:else if form.triggerType === 'http' || form.triggerType === 'manual' || form.triggerType === 'event'}
				{#if form.triggerType === 'event'}
					<div class="flex flex-col gap-2">
						<Label>Event {@render required()}</Label>
						<Select.Root type="single" bind:value={form.event} disabled={readonly}>
							<Select.Trigger class="w-full">
								{eventLabels[form.event]}
							</Select.Trigger>
							<Select.Content>
								{#each AGENT_EVENT_NAMES as option (option)}
									<Select.Item value={option}>{eventLabels[option]}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="flex flex-col gap-2">
						<Label for="agent-every">Run on every Nth occurrence</Label>
						<Input
							id="agent-every"
							type="number"
							min={1}
							max={1000}
							bind:value={form.every}
							disabled={readonly}
						/>
					</div>
				{/if}
				<div class="flex flex-col gap-2">
					<Label for="agent-instructions">Run instructions</Label>
					<Textarea
						id="agent-instructions"
						bind:value={form.instructions}
						rows={4}
						disabled={readonly}
						placeholder="Instructions sent to the agent on each run"
					/>
				</div>
			{/if}
			{#if form.triggerType === 'http'}
				<p class="text-sm text-muted-foreground">
					Trigger via POST /api/agents/{agent?.id ?? '<id>'}/run with Authorization: Bearer &lt;api
					key&gt; — manage keys in Account settings.
					{#if coding}
						API-key runs of a coding agent always use the saved task; custom instructions are
						rejected.
					{/if}
				</p>
			{:else if form.triggerType === 'persona'}
				<p class="text-sm text-muted-foreground">Selectable in the chat top bar.</p>
			{/if}
			<div class="flex items-center justify-between gap-6">
				<Label for="agent-enabled">Enabled</Label>
				<Switch
					id="agent-enabled"
					checked={form.enabled}
					disabled={readonly}
					onCheckedChange={(v) => (form.enabled = v)}
				/>
			</div>
		</Card.Content>
	</Card.Root>

	{#if !coding}
		<Card.Root>
			<Card.Header>
				<Card.Title>Tools</Card.Title>
				<Card.Description>By default agents can use every available tool.</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div class="flex items-center justify-between gap-6">
					<Label for="restrict-tools">Restrict tools</Label>
					<Switch
						id="restrict-tools"
						checked={form.restrictTools}
						disabled={readonly}
						onCheckedChange={(v) => (form.restrictTools = v)}
					/>
				</div>
				{#if form.restrictTools}
					{#each toolGroups as group (group.server)}
						<div class="flex flex-col gap-2">
							<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
								{group.server || 'unknown'}
							</p>
							{#each group.tools as tool (tool.name)}
								<label class="flex items-start gap-2 text-sm">
									<input
										type="checkbox"
										class="mt-0.5 size-4 shrink-0 accent-primary"
										checked={form.allowlist.includes(tool.name)}
										disabled={readonly}
										onchange={(e) => toggleTool(tool.name, e.currentTarget.checked)}
									/>
									<span class="min-w-0">
										<span class="font-medium">{tool.name}</span>
										{#if tool.description}
											<span class="block text-muted-foreground">{tool.description}</span>
										{/if}
									</span>
								</label>
							{/each}
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">No tools available.</p>
					{/each}
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	{#if readonly}
		<div class="flex justify-end">
			<Button variant="outline" href={resolve('/agents')}>Back to agents</Button>
		</div>
	{:else}
		<div class="flex justify-end gap-2">
			<Button variant="outline" href={resolve('/agents')}>Cancel</Button>
			<Button
				onclick={save}
				disabled={busy ||
					!form.name.trim() ||
					!form.systemPrompt.trim() ||
					(coding && !codingTask.draft)}
			>
				{busy ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}
			</Button>
		</div>
	{/if}
</div>
