import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { recordSkillInvocation } from '../../db/repo/skill-invocations.js';
import { publishServerEvent } from '../../events/bus.js';
import { readSkill, resolveSkill, invalidateSkillCache } from '../../skills/scanner.js';
import { findSkillFile, resolveSkillDir, resolveSkillReference } from '../../skills/paths.js';
import { deleteSkill, writeSkill } from '../../skills/store.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const MAX_REFERENCE_BYTES = 256 * 1024;

export function createSkillsServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-skills', version: '0.1.0' });

	server.registerTool(
		'load_skill',
		{
			description:
				'Load a skill (instruction pack) by name. Returns the skill instructions and the list of reference files available via read_skill_reference.',
			inputSchema: { name: z.string().describe('Skill name, e.g. "summarize-conversation"') }
		},
		async ({ name }) => {
			const skill = resolveSkill(ctx.userId, name);
			if (!skill) return err(`skill not found: ${name}`);
			if (!skill.enabled) return err(`skill is disabled: ${name}`);
			recordSkillInvocation(getDb(), {
				skillName: skill.name,
				scope: skill.scope,
				userId: ctx.userId,
				conversationId: ctx.conversationId ?? null,
				messageId: ctx.agentRunId ?? null,
				triggeredBy: ctx.agentRunId ? 'agent' : 'auto'
			});
			const missing = skill.frontmatter.tools.length > 0 ? skill.frontmatter.tools : [];
			return text(
				JSON.stringify({
					name: skill.name,
					title: skill.title,
					description: skill.description,
					when: skill.frontmatter.when,
					declaredTools: skill.frontmatter.tools,
					references: skill.references,
					body: skill.body,
					...(missing.length > 0
						? {
								note: 'This skill declares tools it expects to be available. If a listed tool is not registered in this conversation, tell the user it is unavailable.'
							}
						: {})
				})
			);
		}
	);

	server.registerTool(
		'read_skill_reference',
		{
			description: 'Read a reference markdown file bundled with a skill',
			inputSchema: {
				name: z.string().describe('Skill name'),
				path: z
					.string()
					.describe('Reference path as listed by load_skill, e.g. "references/examples.md"')
			}
		},
		async ({ name, path: relPath }) => {
			const skill = resolveSkill(ctx.userId, name);
			if (!skill) return err(`skill not found: ${name}`);
			const refPath = relPath.startsWith('references/') ? relPath : `references/${relPath}`;
			if (!skill.references.includes(refPath)) return err(`reference not found: ${relPath}`);
			const abs = resolveSkillReference(skill.scope, ctx.userId, skill.name, refPath);
			if (!abs) return err('invalid reference path');
			let content: string;
			try {
				const stat = fs.statSync(abs);
				if (stat.size > MAX_REFERENCE_BYTES) return err('reference too large');
				content = fs.readFileSync(abs, 'utf8');
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
				'Create a new user-scope skill (instruction pack). Fails if a skill with this name already exists in user or shared scope. Use lowercase dash-separated names.',
			inputSchema: {
				name: z
					.string()
					.describe('Skill name: lowercase letters, digits, dashes, e.g. "weekly-report"'),
				description: z.string().describe('When the skill applies, max 500 chars'),
				body: z.string().describe('Skill instructions (markdown)'),
				title: z.string().optional().describe('Display title; defaults to humanized name'),
				when: z.string().optional().describe('Optional extra condition describing when to load'),
				tools: z
					.array(z.string())
					.optional()
					.describe('Tool names this skill expects to be available'),
				references: z
					.array(
						z.object({
							path: z
								.string()
								.describe(
									'Reference filename as reported by load_skill, e.g. "template.md" or "guide/setup.md"; stored under references/'
								),
							content: z.string()
						})
					)
					.optional()
					.describe('Optional reference markdown files bundled with the skill')
			}
		},
		async ({ name, description, body, title, when, tools, references }) => {
			if (resolveSkill(ctx.userId, name)) return err(`skill already exists: ${name}`);
			let skill;
			try {
				skill = writeSkill('user', ctx.userId, { name, title, description, when, tools, body });
				writeReferences(ctx.userId, name, references);
			} catch (e) {
				deleteSkill('user', ctx.userId, name);
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
				'Update an existing user-scope skill. If the name only exists as a shared skill, creates a user-scope override (shadow) instead. Omitted fields keep their current values.',
			inputSchema: {
				name: z.string().describe('Skill name'),
				body: z.string().optional().describe('New skill instructions (markdown)'),
				title: z.string().optional(),
				description: z.string().optional(),
				when: z.string().nullable().optional().describe('Set to null to clear'),
				tools: z.array(z.string()).optional(),
				enabled: z.boolean().optional(),
				version: z.string().nullable().optional().describe('Set to null to clear'),
				author: z.string().nullable().optional().describe('Set to null to clear'),
				references: z
					.array(
						z.object({
							path: z
								.string()
								.describe(
									'Reference filename as reported by load_skill, e.g. "template.md" or "guide/setup.md"; stored under references/'
								),
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
			const existing = resolveSkill(ctx.userId, name);
			if (!existing) return err(`skill not found: ${name}`);
			let skill;
			try {
				skill = writeSkill('user', ctx.userId, {
					name: existing.name,
					title: title ?? existing.title,
					description: description ?? existing.description,
					when: when === undefined ? existing.frontmatter.when : when,
					tools: tools ?? existing.frontmatter.tools,
					enabled: enabled ?? existing.enabled,
					version: version === undefined ? existing.version : version,
					author: author === undefined ? existing.author : author,
					body: body ?? existing.body
				});
				writeReferences(ctx.userId, name, references);
			} catch (e) {
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
			description:
				'Delete a user-scope skill, including its reference files. Shared skills cannot be deleted this way.',
			inputSchema: { name: z.string().describe('Skill name') }
		},
		async ({ name }) => {
			const existing = readSkill('user', ctx.userId, name);
			if (!existing) {
				return err(
					resolveSkill(ctx.userId, name)
						? `skill "${name}" is shared and cannot be deleted with this tool`
						: `skill not found: ${name}`
				);
			}
			deleteSkill('user', ctx.userId, name);
			publishServerEvent(ctx.userId, { type: 'skills.changed' });
			publishServerEvent(ctx.userId, { type: 'skill.deleted', name, scope: 'user' });
			return text(`deleted skill: ${name}`);
		}
	);

	return server;
}

function writeReferences(
	userId: string,
	name: string,
	references: Array<{ path: string; content: string }> | undefined
): void {
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
		if (!dir || !findSkillFile(dir)) throw new Error(`skill not found: ${name}`);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, ref.content);
	}
	invalidateSkillCache();
}
