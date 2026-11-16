import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { listAgents } from '../../db/repo/agents.js';
import {
	countCodingEnvironments,
	listCodingEnvironments
} from '../../db/repo/coding-environments.js';
import {
	PROPOSE_CODING_TASK_TOOL,
	type CodingTaskProposalTarget
} from '$lib/coding-task-proposal.js';
import { createLogger } from '../../logger.js';
import { getCodingOptions, MAX_LAUNCH_PROMPT, resolveCodingTarget } from '../../t3/tasks.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const log = createLogger('mcp:coding');

const NO_ENVIRONMENT =
	'the user has no coding environment set up; they can connect one in Settings → Coding environments';

export function createCodingServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-coding', version: '0.1.0' });

	server.registerTool(
		'list_coding_projects',
		{
			description:
				"List the projects (code repositories) on the user's coding environments, with the ids propose_coding_task takes."
		},
		async () => {
			const db = getDb();
			const environments = listCodingEnvironments(db, ctx.userId).filter((e) => e.enabled === 1);
			if (environments.length === 0) return err(NO_ENVIRONMENT);
			const result = await Promise.all(
				environments.map(async (env) => {
					try {
						const { projects } = await getCodingOptions(ctx.userId, env.id, db);
						return {
							environmentId: env.id,
							environmentName: env.name,
							projects: projects.map((p) => ({
								projectId: p.id,
								title: p.title,
								isGitRepo: p.isGitRepo,
								defaultBranch: p.defaultBranch
							}))
						};
					} catch (e) {
						return {
							environmentId: env.id,
							environmentName: env.name,
							error: e instanceof Error ? e.message : 'unreachable'
						};
					}
				})
			);
			log.info('list_coding_projects', { userId: ctx.userId, environments: result.length });
			return text(JSON.stringify(result));
		}
	);

	// Only proposes: the chat shows the task as a card and the user starts it
	// (choosing where, possibly editing it). A chat model never directs work in
	// the user's repositories on its own, see start_agent (agents server).
	server.registerTool(
		PROPOSE_CODING_TASK_TOOL,
		{
			description:
				"Propose a task for a coding agent in one of the user's repositories, when they want code written, changed, fixed or reviewed. Nothing starts: the user sees a card, picks where it runs (preselected if you pass environmentId + projectId from list_coding_projects), may edit the task and starts it. " +
				"The coding agent hasn't seen this chat and you can't see the code: write a self-contained prompt with what the chat established, say what is unknown, and don't guess the language, framework, files or tooling.",
			inputSchema: {
				title: z.string().trim().max(120).optional().describe('Short title for the task'),
				prompt: z
					.string()
					.trim()
					.min(1)
					.max(MAX_LAUNCH_PROMPT)
					.describe(
						'The task as direct instructions to the coding agent, in markdown: the goal, every relevant decision and detail from the chat, what is out of scope, and how to verify the work'
					),
				environmentId: z.string().optional().describe('From list_coding_projects'),
				projectId: z.string().optional().describe('From list_coding_projects; needs environmentId')
			}
		},
		async ({ title, environmentId, projectId }) => {
			// The card needs the user's chat to start from; agent runs have none.
			if (ctx.agentRunId) return err('coding tasks can only be proposed in a chat with the user');
			const db = getDb();
			if (!!environmentId !== !!projectId) {
				return err('give environmentId and projectId together, or neither');
			}
			const hasTarget =
				countCodingEnvironments(db, ctx.userId) > 0 ||
				listAgents(db, ctx.userId).some((a) => a.user_id === ctx.userId && a.coding_target);
			if (!hasTarget) return err(NO_ENVIRONMENT);
			let target: CodingTaskProposalTarget | null = null;
			if (environmentId && projectId) {
				try {
					// 'local' skips the git check: the user picks the workspace in the dialog.
					const { env, project } = await resolveCodingTarget(
						ctx.userId,
						{ environmentId, projectId, workspaceMode: 'local' },
						db
					);
					target = {
						environmentId: env.id,
						environmentName: env.name,
						projectId: project.id,
						projectTitle: project.title
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : 'could not check the project';
					return err(`${message}; call list_coding_projects for valid ids`);
				}
			}
			log.info('propose_coding_task', {
				userId: ctx.userId,
				conversationId: ctx.conversationId,
				projectId: target?.projectId
			});
			return text(
				JSON.stringify({
					proposed: true,
					title: title || null,
					target,
					note: 'The user now sees the task as a card with a "Review & start" button. Nothing has started. Do not repeat the task in your reply; briefly say it is ready to review.'
				})
			);
		}
	);

	return server;
}
