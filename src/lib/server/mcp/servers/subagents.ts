import { callerPrivacy } from '../../privacy/policy.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MAX_CONCURRENT_SUBAGENTS, RUN_SUBAGENT_TOOL } from '$lib/subagent-tool.js';
import { currentToolCallId } from '../../tools/call-context.js';
import { MAX_LAUNCH_PROMPT } from '../../t3/tasks.js';
import type { CallerContext } from '../types.js';
import { err } from './shared.js';

export function createSubagentsServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-subagents', version: '0.1.0' });

	server.registerTool(
		RUN_SUBAGENT_TOOL,
		{
			description:
				'Delegate one self-contained task to a subagent: a fresh assistant with its own context and your tools (or fewer) that returns only its final report. ' +
				'Use it for work that would flood your context (research across many pages or files, long searches, big documents) or to run independent tasks in parallel: ' +
				`several calls at once, up to ${MAX_CONCURRENT_SUBAGENTS}. ` +
				"It hasn't seen this chat and can't ask questions: give it the goal, every relevant detail and what its report should contain. " +
				'Relay what matters from the report to the user. Subagents cannot start subagents.',
			inputSchema: {
				description: z.string().trim().min(1).max(80).describe('3-6 word label shown to the user'),
				prompt: z
					.string()
					.trim()
					.min(1)
					.max(MAX_LAUNCH_PROMPT)
					.describe('The complete task, written for someone who has not seen this conversation'),
				tools: z
					.array(z.string().min(1).max(200))
					.max(200)
					.optional()
					.describe(
						'Limit it to these of your tool names (fewer = more focused); omit for all of yours. Names you lack are dropped and listed in `droppedTools`.'
					)
			}
		},
		async ({ description, prompt, tools }, extra) => {
			if (!ctx.conversationId) return err('subagents can only be started from a conversation');
			const { runSubagent, SubagentError } = await import('../../agents/subagents.js');
			try {
				const result = await runSubagent({
					userId: ctx.userId,
					parentConversationId: ctx.conversationId,
					description,
					prompt,
					tools,
					toolCallId: currentToolCallId(),
					signal: extra.signal,
					parentPrivacy: callerPrivacy(ctx),
					parentPrivateOnly: ctx.privateOnly
				});
				const outcome =
					result.status === 'completed' && !result.result
						? 'The subagent finished without writing a report (it may have run out of steps). Read its transcript with read_chat to see what it did, or retry with a narrower task.'
						: result.status === 'completed'
							? 'The subagent finished; `result` is its report. The user can open the report and the full transcript from the subagent row in the chat, so answer from it in your own words instead of copying it out; quote code or data exactly when you do show them.'
							: result.status === 'stopped'
								? 'The subagent was stopped before it finished.'
								: 'The subagent failed; see `error`. Its partial work, if any, is in its transcript.';
				const note = [
					outcome,
					result.droppedTools?.length
						? `It didn't get these requested tools, which you don't have: ${result.droppedTools.join(', ')}.`
						: null,
					'read_chat with conversationId shows you the transcript; never give the user conversation ids.'
				]
					.filter(Boolean)
					.join(' ');
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ ...result, note }) }],
					isError: result.status !== 'completed'
				};
			} catch (e) {
				if (e instanceof SubagentError) return err(e.message);
				throw e;
			}
		}
	);

	return server;
}
