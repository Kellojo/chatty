import fsp from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { recordSkillInvocation } from '../../db/repo/skill-invocations.js';
import { publishServerEvent } from '../../events/bus.js';
import { readSkill, resolveSkill, invalidateSkillCache } from '../../skills/scanner.js';
import { findSkillFile, resolveSkillDir, resolveSkillReference } from '../../skills/paths.js';
import { copySkillReferences, deleteSkill, writeSkill } from '../../skills/store.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const MAX_REFERENCE_BYTES = 256 * 1024;
const REFERENCE_PATH = 'Path under references/, e.g. "template.md" or "guide/setup.md"';

export function createSkillsServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-skills', version: '0.1.0' });

	server.registerTool(
		'load_skill',
		{
			description:
				'Load a skill (instruction pack) by name: returns its instructions and its reference files (read them with read_skill_reference).',
			inputSchema: { name: z.string().describe('Skill name, e.g. "summarize-conversation"') }
		},
		async ({ name }) => {
			const skill = await resolveSkill(ctx.userId, name);
			if (!skill) return err(`skill not found: ${name}`);
			if (!skill.enabled) return err(`skill is disabled: ${name}`);
			recordSkillInvocation(getDb(), {
				skillName: skill.name,
				scope: skill.scope,
				userId: ctx.userId,
				conversationId: ctx.conversationId ?? null,
				// The user message the turn answers (the reply is only persisted later).
				messageId: ctx.messageId ?? null,
				triggeredBy: ctx.agentRunId ? 'agent' : 'auto'
			});
			// This server cannot see which tools the conversation has registered (it
			// is created per caller, independent of the chat's tool set), so it can't
			// compute which declared tools are missing — the model can, from its own
			// tool list, so it is asked to check.
			const declaredTools = skill.frontmatter.tools;
			return text(
				JSON.stringify({
					name: skill.name,
					title: skill.title,
					description: skill.description,
					when: skill.frontmatter.when,
					declaredTools,
					references: skill.references,
					body: skill.body,
					...(declaredTools.length > 0
						? {
								note: 'This skill declares tools it expects to be available. Compare declaredTools with the tools you have; if one is missing, tell the user it is unavailable.'
							}
						: {})
				})
			);
		}
	);

	server.registerTool(
		'read_skill_reference',
		{
			description: 'Read a reference file bundled with a skill.',
			inputSchema: {
				name: z.string().describe('Skill name'),
				path: z.string().describe('Path as listed by load_skill, e.g. "references/examples.md"')
			}
		},
		async ({ name, path: relPath }) => {
			const skill = await resolveSkill(ctx.userId, name);
			if (!skill) return err(`skill not found: ${name}`);
			const refPath = relPath.startsWith('references/') ? relPath : `references/${relPath}`;
			if (!skill.references.includes(refPath)) return err(`reference not found: ${relPath}`);
			const abs = resolveSkillReference(skill.scope, ctx.userId, skill.name, refPath);
			if (!abs) return err('invalid reference path');
			let content: string;
			try {
				const stat = await fsp.stat(abs);
				if (stat.size > MAX_REFERENCE_BYTES) return err('reference too large');
				content = await fsp.readFile(abs, 'utf8');
			} catch {
				return err(`reference not found: ${relPath}`);
			}
			return text(content);
		}
	);

	server.registerTool(
		'create_skill',
		{
			description:
				'Create a user skill (instruction pack). Fails if the name exists as a user or shared skill.',
			inputSchema: {
				name: z
					.string()
					.describe('Skill name: lowercase letters, digits, dashes, e.g. "weekly-report"'),
				description: z.string().describe('When the skill applies (max 500 chars)'),
				body: z.string().describe('Skill instructions (markdown)'),
				title: z.string().optional().describe('Display title; defaults to humanized name'),
				when: z.string().optional().describe('Extra condition for when to load it'),
				tools: z
					.array(z.string())
					.optional()
					.describe('Tool names this skill expects to be available'),
				references: z
					.array(
						z.object({
							path: z.string().describe(REFERENCE_PATH),
							content: z.string()
						})
					)
					.optional()
					.describe('Reference markdown files bundled with the skill')
			}
		},
		async ({ name, description, body, title, when, tools, references }) => {
			if (await resolveSkill(ctx.userId, name)) return err(`skill already exists: ${name}`);
			let skill;
			try {
				skill = await writeSkill('user', ctx.userId, {
					name,
					title,
					description,
					when,
					tools,
					body
				});
				await writeReferences(ctx.userId, name, references);
			} catch (e) {
				await deleteSkill('user', ctx.userId, name);
				return err(e instanceof Error ? e.message : 'failed to create skill');
			}
			publishServerEvent(ctx.userId, { type: 'skills.changed' });
			publishServerEvent(ctx.userId, { type: 'skill.created', name: skill.name, scope: 'user' });
			return text(JSON.stringify({ name: skill.name, title: skill.title, scope: skill.scope }));
		}
	);

	server.registerTool(
		'update_skill',
		{
			description:
				'Update a user skill; omitted fields are kept, null clears. For a shared skill this creates a user override.',
			inputSchema: {
				name: z.string().describe('Skill name'),
				body: z.string().optional().describe('New skill instructions (markdown)'),
				title: z.string().optional(),
				description: z.string().optional(),
				when: z.string().nullable().optional(),
				tools: z.array(z.string()).optional(),
				enabled: z.boolean().optional(),
				version: z.string().nullable().optional(),
				author: z.string().nullable().optional(),
				references: z
					.array(
						z.object({
							path: z.string().describe(REFERENCE_PATH),
							content: z.string()
						})
					)
					.optional()
					.describe('Reference files to write or overwrite')
			}
		},
		async ({
			name,
			body,
			title,
			description,
			when,
			tools,
			enabled,
			version,
			author,
			references
		}) => {
			const existing = await resolveSkill(ctx.userId, name);
			if (!existing) return err(`skill not found: ${name}`);
			// A shared-only skill gets a user-scope override that starts as a full
			// copy of it (frontmatter and reference files), with the patch applied.
			const creatingOverride = existing.scope === 'shared';
			let skill;
			try {
				skill = await writeSkill('user', ctx.userId, {
					name: existing.name,
					title: title ?? existing.title,
					description: description ?? existing.description,
					triggers: existing.frontmatter.triggers,
					when: when === undefined ? existing.frontmatter.when : when,
					tools: tools ?? existing.frontmatter.tools,
					enabled: enabled ?? existing.enabled,
					source: existing.frontmatter.source,
					version: version === undefined ? existing.version : version,
					author: author === undefined ? existing.author : author,
					body: body ?? existing.body
				});
				if (creatingOverride) {
					await copySkillReferences('shared', 'user', ctx.userId, existing.name);
				}
				await writeReferences(ctx.userId, existing.name, references);
			} catch (e) {
				if (creatingOverride) await deleteSkill('user', ctx.userId, existing.name);
				return err(e instanceof Error ? e.message : 'failed to update skill');
			}
			publishServerEvent(ctx.userId, { type: 'skills.changed' });
			publishServerEvent(ctx.userId, { type: 'skill.updated', name: skill.name, scope: 'user' });
			return text(JSON.stringify({ name: skill.name, title: skill.title, scope: skill.scope }));
		}
	);

	server.registerTool(
		'delete_skill',
		{
			description: "Delete a user skill and its reference files (shared skills can't be deleted).",
			inputSchema: { name: z.string().describe('Skill name') }
		},
		async ({ name }) => {
			const existing = await readSkill('user', ctx.userId, name);
			if (!existing) {
				return err(
					(await resolveSkill(ctx.userId, name))
						? `skill "${name}" is shared and cannot be deleted with this tool`
						: `skill not found: ${name}`
				);
			}
			await deleteSkill('user', ctx.userId, name);
			publishServerEvent(ctx.userId, { type: 'skills.changed' });
			publishServerEvent(ctx.userId, { type: 'skill.deleted', name, scope: 'user' });
			return text(`deleted skill: ${name}`);
		}
	);

	return server;
}

async function writeReferences(
	userId: string,
	name: string,
	references: Array<{ path: string; content: string }> | undefined
): Promise<void> {
	for (const ref of references ?? []) {
		const posix = ref.path.split('\\').join('/');
		if (posix === 'skill.md' || posix.toUpperCase() === 'SKILL.MD') {
			throw new Error(`reference path not allowed: ${ref.path}`);
		}
		if (!posix.endsWith('.md')) throw new Error(`reference must be a .md file: ${ref.path}`);
		const rel = posix.startsWith('references/') ? posix : `references/${posix}`;
		const abs = resolveSkillReference('user', userId, name, rel);
		if (!abs) throw new Error(`invalid reference path: ${ref.path}`);
		const dir = resolveSkillDir('user', userId, name);
		if (!dir || !(await findSkillFile(dir))) throw new Error(`skill not found: ${name}`);
		await fsp.mkdir(path.dirname(abs), { recursive: true });
		await fsp.writeFile(abs, ref.content);
	}
	invalidateSkillCache();
}
