// Selection state for starting a coding task (environment, project, model,
// branch, autonomy). Shared by the start page's model picker (inside the
// prompt box) and the context bar below it.

import { SvelteMap } from 'svelte/reactivity';
import type {
	AgentCodingTarget,
	CodingAutonomy,
	CodingEnvironment,
	CodingModelOption,
	CodingModelRef,
	CodingProjectOption,
	CodingWorkspaceMode
} from '$lib/coding-environments.js';

/** Everything POST /api/coding/tasks needs. */
export interface CodingTaskDraft {
	environmentId: string;
	projectId: string;
	providerInstanceId: string;
	model: string;
	autonomy: CodingAutonomy;
	workspaceMode: CodingWorkspaceMode;
	baseBranch?: string;
}

export interface CodingOptions {
	projects: CodingProjectOption[];
	models: CodingModelOption[];
	defaultModel: CodingModelRef | null;
	/** The environment's own default for new threads, when it reports one. */
	defaultAutonomy: CodingAutonomy | null;
	defaultWorkspaceMode: CodingWorkspaceMode | null;
}

export interface CodingBranch {
	name: string;
	isDefault: boolean;
	current: boolean;
}

interface BranchesResult {
	isRepo: boolean;
	branches: CodingBranch[];
}

interface Stored {
	environmentId?: string;
	projectId?: string;
	/** Only set once the user picked a model themselves (otherwise T3's default wins). */
	modelChoice?: CodingModelRef;
	/** Only set once the user picked an autonomy level themselves. */
	autonomyChoice?: CodingAutonomy;
	/** Branch name, or LOCAL for the project checkout. */
	branch?: string;
}

const STORAGE_KEY = 'chatty.codingTask.last';
// `:` can't appear in git ref names, so this never collides with a branch.
export const LOCAL_CHECKOUT = ':local';

export const AUTONOMY_OPTIONS: {
	value: CodingAutonomy;
	label: string;
	/** Fits a phone-width chip. */
	short: string;
	hint: string;
}[] = [
	{
		value: 'supervised',
		label: 'Ask first',
		short: 'Ask',
		hint: 'Asks before running commands or editing'
	},
	{
		value: 'auto-edits',
		label: 'Auto-accept edits',
		short: 'Edits',
		hint: 'Edits freely, asks before commands'
	},
	{
		value: 'auto',
		label: 'Auto',
		short: 'Auto',
		hint: 'Runs safe actions on its own, asks before risky ones'
	},
	{
		value: 'full-access',
		label: 'Full access',
		short: 'Full access',
		hint: 'Never asks for approval'
	}
];

const isAutonomy = (v: unknown): v is CodingAutonomy => AUTONOMY_OPTIONS.some((a) => a.value === v);

export const encodeCodingModel = (m: CodingModelRef) =>
	JSON.stringify([m.providerInstanceId, m.model]);

function readStored(): Stored {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		return parsed && typeof parsed === 'object' ? (parsed as Stored) : {};
	} catch {
		return {};
	}
}

function writeStored(next: Stored) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// storage unavailable (private mode, quota) — selections just aren't remembered
	}
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
	const data = (await res.json().catch(() => null)) as { message?: string } | null;
	return data?.message ?? fallback;
}

export class CodingTaskState {
	readonly environments: CodingEnvironment[];

	environmentId = $state('');
	projectId = $state('');
	modelValue = $state('');
	branchValue = $state('');
	autonomy = $state<CodingAutonomy>('auto');
	/** True once the user picked autonomy explicitly (otherwise the environment default wins). */
	private autonomyChosen = false;
	/** The model the user picked explicitly; null follows T3's default. */
	private modelChoice: CodingModelRef | null = null;

	options = $state<CodingOptions | null>(null);
	optionsLoading = $state(false);
	optionsError = $state<string | null>(null);
	branches = $state<BranchesResult | null>(null);
	branchesLoading = $state(false);
	branchesError = $state<string | null>(null);

	private readonly stored: Stored;
	/** False when editing a saved target (e.g. a coding agent): selections stay out of localStorage. */
	private readonly remember: boolean;
	// Successful responses only; failures are retried on the next selection.
	private readonly optionsCache = new SvelteMap<string, CodingOptions>();
	private readonly branchesCache = new SvelteMap<string, BranchesResult>();

	/**
	 * `initial` starts from a saved target (a coding agent's) instead of the
	 * last selection. `remember` (default: true without `initial`) controls
	 * whether picks update the start page's remembered selection.
	 */
	constructor(
		environments: CodingEnvironment[],
		opts: { initial?: AgentCodingTarget | null; remember?: boolean } = {}
	) {
		this.environments = environments;
		const initial = opts.initial;
		this.remember = opts.remember ?? !initial;
		this.stored = initial
			? {
					environmentId: initial.environmentId,
					projectId: initial.projectId,
					modelChoice: { providerInstanceId: initial.providerInstanceId, model: initial.model },
					autonomyChoice: initial.autonomy,
					branch:
						initial.workspaceMode === 'local' ? LOCAL_CHECKOUT : (initial.baseBranch ?? undefined)
				}
			: readStored();
		if (isAutonomy(this.stored.autonomyChoice)) {
			this.autonomy = this.stored.autonomyChoice;
			this.autonomyChosen = true;
		}
		const choice = this.stored.modelChoice;
		if (choice?.providerInstanceId && choice.model) {
			this.modelChoice = { providerInstanceId: choice.providerInstanceId, model: choice.model };
		}
	}

	readonly environment = $derived.by(() =>
		this.environments.find((e) => e.id === this.environmentId)
	);
	readonly project = $derived(this.options?.projects.find((p) => p.id === this.projectId) ?? null);
	readonly isRepo = $derived(
		this.branches ? this.branches.isRepo : (this.project?.isGitRepo ?? false)
	);
	/** Checked-out branch first, then the default/main line, then the rest as T3 listed them. */
	readonly branchList = $derived.by((): CodingBranch[] => {
		if (this.branches) {
			const rank = (b: CodingBranch) =>
				b.current ? 0 : b.isDefault || b.name === 'main' || b.name === 'master' ? 1 : 2;
			return this.branches.branches
				.map((b, i) => ({ b, i }))
				.sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i)
				.map(({ b }) => b);
		}
		return this.project?.defaultBranch
			? [{ name: this.project.defaultBranch, isDefault: true, current: false }]
			: [];
	});
	readonly selectedModel = $derived(
		this.options?.models.find((m) => encodeCodingModel(m) === this.modelValue) ?? null
	);
	readonly modelGroups = $derived.by(() => {
		const groups: { label: string; models: CodingModelOption[] }[] = [];
		for (const model of this.options?.models ?? []) {
			let group = groups.find((g) => g.label === model.providerLabel);
			if (!group) {
				group = { label: model.providerLabel, models: [] };
				groups.push(group);
			}
			group.models.push(model);
		}
		return groups;
	});
	readonly autonomyOption = $derived(
		AUTONOMY_OPTIONS.find((a) => a.value === this.autonomy) ?? AUTONOMY_OPTIONS[0]
	);

	readonly draft = $derived.by((): CodingTaskDraft | null => {
		if (!this.environmentId || !this.project || !this.selectedModel || !this.branchValue) {
			return null;
		}
		const local = this.branchValue === LOCAL_CHECKOUT;
		return {
			environmentId: this.environmentId,
			projectId: this.project.id,
			providerInstanceId: this.selectedModel.providerInstanceId,
			model: this.selectedModel.model,
			autonomy: this.autonomy,
			workspaceMode: local ? 'local' : 'worktree',
			...(local ? {} : { baseBranch: this.branchValue })
		};
	});

	/** Why the task can't start yet, for the send button's tooltip. */
	readonly blocker = $derived.by((): string | null => {
		if (this.optionsLoading) return 'Connecting to the coding environment…';
		if (this.optionsError) return 'The coding environment is unreachable';
		if (!this.options) return 'Choose a coding environment';
		if (this.options.projects.length === 0) return 'Create or clone a project first';
		if (!this.project) return 'Choose a project';
		if (this.options.models.length === 0) {
			return 'No coding agents are set up on this environment';
		}
		if (!this.selectedModel) return 'Choose a model';
		if (this.branchesLoading) return 'Loading branches…';
		return null;
	});

	/** T3's default model for this project (override, project setting, then server-wide). */
	readonly defaultModel = $derived(
		this.project?.defaultModel ?? this.options?.defaultModel ?? null
	);

	/** T3's own default for this project (project override, else the environment's). */
	readonly defaultAutonomy = $derived(
		this.project?.defaultAutonomy ?? this.options?.defaultAutonomy ?? null
	);

	/** Restores the last selection (or the first environment). Call once on mount. */
	init(): void {
		const initial =
			this.environments.find((e) => e.id === this.stored.environmentId) ?? this.environments[0];
		if (initial) void this.selectEnvironment(initial.id);
	}

	/** Picking T3's default again goes back to following it (also for other projects). */
	setAutonomy(value: CodingAutonomy): void {
		this.autonomy = value;
		this.autonomyChosen = value !== this.defaultAutonomy;
		this.persist();
	}

	/** Picking T3's default again goes back to following it. */
	setModel(value: string): void {
		this.modelValue = value;
		const picked = this.options?.models.find((m) => encodeCodingModel(m) === value);
		const isDefault = !!this.defaultModel && value === encodeCodingModel(this.defaultModel);
		this.modelChoice =
			picked && !isDefault
				? { providerInstanceId: picked.providerInstanceId, model: picked.model }
				: null;
		this.persist();
	}

	setBranch(value: string): void {
		this.branchValue = value;
		this.persist();
	}

	async selectEnvironment(id: string, opts: { refresh?: boolean; projectId?: string } = {}) {
		this.environmentId = id;
		this.options = null;
		this.optionsLoading = false;
		this.optionsError = null;
		this.projectId = '';
		this.modelValue = '';
		this.branches = null;
		this.branchValue = '';
		if (!id) return;
		if (opts.refresh) this.optionsCache.delete(id);
		let result = this.optionsCache.get(id);
		if (!result) {
			this.optionsLoading = true;
			try {
				const res = await fetch(`/api/coding/options?environmentId=${encodeURIComponent(id)}`);
				if (!res.ok) throw new Error(await errorMessage(res, 'Could not reach the environment'));
				result = (await res.json()) as CodingOptions;
				this.optionsCache.set(id, result);
			} catch (e) {
				if (this.environmentId === id) {
					this.optionsError = e instanceof Error ? e.message : 'Could not reach the environment';
				}
				return;
			} finally {
				if (this.environmentId === id) this.optionsLoading = false;
			}
		}
		if (this.environmentId !== id) return;
		this.options = result;

		const stored = this.stored;
		const remembered = stored.environmentId === id;
		this.applyDefaults();

		const wanted = opts.projectId ?? (remembered ? stored.projectId : undefined);
		const nextProject = result.projects.find((p) => p.id === wanted) ?? result.projects[0];
		if (nextProject) await this.selectProject(nextProject.id);
	}

	async selectProject(id: string) {
		const envId = this.environmentId;
		this.projectId = id;
		this.branches = null;
		this.branchesLoading = false;
		this.branchesError = null;
		this.branchValue = '';
		if (!id || !envId) return;
		this.applyDefaults();
		const key = `${envId}\n${id}`;
		let result = this.branchesCache.get(key);
		if (!result) {
			this.branchesLoading = true;
			try {
				const query = `environmentId=${encodeURIComponent(envId)}&projectId=${encodeURIComponent(id)}`;
				const res = await fetch(`/api/coding/branches?${query}`);
				if (!res.ok) throw new Error(await errorMessage(res, 'Could not load branches'));
				result = (await res.json()) as BranchesResult;
				this.branchesCache.set(key, result);
			} catch (e) {
				if (this.projectId === id && this.environmentId === envId) {
					this.branchesError = e instanceof Error ? e.message : 'Could not load branches';
					this.applyDefaults();
					this.branchValue = this.pickBranch(id);
					this.persist();
				}
				return;
			} finally {
				if (this.projectId === id && this.environmentId === envId) this.branchesLoading = false;
			}
		}
		if (this.projectId !== id || this.environmentId !== envId) return;
		this.branches = result;
		this.applyDefaults();
		this.branchValue = this.pickBranch(id);
		this.persist();
	}

	/** Reloads the environment's projects and selects `projectId` (e.g. one just created). */
	async reloadAndSelect(projectId: string) {
		await this.selectEnvironment(this.environmentId, { refresh: true, projectId });
	}

	private pickBranch(forProject: string): string {
		if (!this.isRepo) return LOCAL_CHECKOUT;
		const list = this.branchList;
		const stored = this.stored;
		if (stored.environmentId === this.environmentId && stored.projectId === forProject) {
			if (stored.branch === LOCAL_CHECKOUT) return LOCAL_CHECKOUT;
			if (stored.branch && list.some((b) => b.name === stored.branch)) return stored.branch;
		}
		// Follow the environment's preference for new threads when it has one.
		const workspaceMode =
			this.project?.defaultWorkspaceMode ?? this.options?.defaultWorkspaceMode ?? null;
		if (workspaceMode === 'local') return LOCAL_CHECKOUT;
		const preferred =
			list.find((b) => b.isDefault) ??
			list.find((b) => b.name === this.project?.defaultBranch) ??
			list.find((b) => b.current) ??
			list[0];
		return preferred?.name ?? LOCAL_CHECKOUT;
	}

	/**
	 * Until the user picks their own, use T3's defaults for the current
	 * project (or the environment, before a project is selected).
	 */
	private applyDefaults(): void {
		if (!this.autonomyChosen && this.defaultAutonomy) this.autonomy = this.defaultAutonomy;

		const models = this.options?.models ?? [];
		const choice = this.modelChoice;
		const model =
			(choice && models.find((m) => encodeCodingModel(m) === encodeCodingModel(choice))) ??
			(this.defaultModel &&
				models.find((m) => encodeCodingModel(m) === encodeCodingModel(this.defaultModel!))) ??
			models[0];
		this.modelValue = model ? encodeCodingModel(model) : '';
	}

	private persist(): void {
		const next: Stored = {
			environmentId: this.environmentId || undefined,
			projectId: this.projectId || undefined,
			// Kept even while unavailable here, so it still applies on other environments.
			modelChoice: this.modelChoice ?? undefined,
			autonomyChoice: this.autonomyChosen ? this.autonomy : undefined,
			branch: this.branchValue || undefined
		};
		Object.assign(this.stored, next);
		if (this.remember) writeStored(next);
	}
}
