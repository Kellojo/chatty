import {
	wrapLanguageModel,
	type LanguageModel,
	type LanguageModelMiddleware,
	type ModelMessage
} from 'ai';
import { estimateValueTokens } from '../agents/stepCompaction.js';
import {
	isContextOverflowError,
	noteContextOverflow,
	noteContextSuccess,
	statedContextLimit
} from '../llm/contextLimit.js';
import { createLogger } from '../logger.js';

/**
 * Recovers a model call whose prompt didn't fit the context window. The
 * overflow lowers the model's learned limit (see contextLimit), so later steps
 * and runs budget against it; a call rejected before any output is compacted
 * to the new limit and sent once more. Successful calls raise the limit's
 * floor, so it settles on what really fits instead of shrinking for good.
 */

const log = createLogger('overflow-retry');

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]['model'];
type Middleware = Extract<LanguageModelMiddleware, { wrapStream?: unknown }>;
type WrapStream = NonNullable<Middleware['wrapStream']>;
type StreamResult = Awaited<ReturnType<WrapStream>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

/** Parts sent before the model has produced anything. */
const PREAMBLE = new Set(['stream-start', 'response-metadata', 'ping', 'raw']);

export interface OverflowRetryOptions {
	target: { providerId: string; modelId: string };
	/** The context the model reports right now (learned limits are tied to it). */
	reportedContextLength: () => Promise<number | null>;
	/**
	 * Shrinks a rejected prompt to fit `contextLength`; null when nothing could
	 * be cut, and the error then stands.
	 */
	compact: (input: {
		messages: ModelMessage[];
		promptTokens: number;
		contextLength: number;
	}) => Promise<ModelMessage[] | null>;
}

function totalOf(value: unknown): number {
	if (typeof value === 'number') return value;
	const total = (value as { total?: unknown } | null)?.total;
	return typeof total === 'number' ? total : 0;
}

export function contextOverflowMiddleware(opts: OverflowRetryOptions): LanguageModelMiddleware {
	const { target } = opts;

	/** Passes `head` then the rest of `reader` on, learning from how the call ends. */
	const watch = (
		head: StreamPart[],
		reader: ReadableStreamDefaultReader<StreamPart>,
		promptTokens: number
	) =>
		new ReadableStream<StreamPart>({
			start(controller) {
				for (const part of head) observe(part, promptTokens);
				for (const part of head) controller.enqueue(part);
			},
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) return controller.close();
					observe(value, promptTokens);
					controller.enqueue(value);
				} catch (e) {
					controller.error(e);
				}
			},
			cancel(reason) {
				return reader.cancel(reason);
			}
		});

	const observe = (part: StreamPart, promptTokens: number) => {
		const p = part as {
			type: string;
			error?: unknown;
			usage?: { inputTokens?: unknown; outputTokens?: unknown };
		};
		if (p.type === 'error' && isContextOverflowError(p.error)) {
			// Too late to retry (output was already sent), but later calls learn from it.
			void learn(p.error, promptTokens).catch(() => undefined);
		} else if (p.type === 'finish' && p.usage) {
			const tokens = totalOf(p.usage.inputTokens) + totalOf(p.usage.outputTokens);
			if (tokens > 0) {
				void opts
					.reportedContextLength()
					.then((basis) => noteContextSuccess(target, { tokens, basis }))
					.catch(() => undefined);
			}
		}
	};

	const learn = async (error: unknown, promptTokens: number) =>
		noteContextOverflow(target, {
			promptTokens,
			statedLimit: statedContextLimit(error),
			basis: await opts.reportedContextLength()
		});

	/** Reads parts up to the first output; returns the overflow error if that came first. */
	const peek = async (reader: ReadableStreamDefaultReader<StreamPart>) => {
		const head: StreamPart[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return { head, overflow: null };
			head.push(value);
			const type = (value as { type: string }).type;
			if (type === 'error') {
				const error = (value as { error?: unknown }).error;
				return { head, overflow: isContextOverflowError(error) ? { error } : null };
			}
			if (!PREAMBLE.has(type)) return { head, overflow: null };
		}
	};

	return {
		specificationVersion: 'v4',
		wrapStream: async ({ doStream, params, model }) => {
			const promptTokens =
				estimateValueTokens(params.prompt) + estimateValueTokens(params.tools ?? []);

			const retry = async (error: unknown): Promise<StreamResult> => {
				const contextLength = await learn(error, promptTokens);
				const messages = await opts.compact({
					messages: params.prompt as unknown as ModelMessage[],
					promptTokens,
					contextLength
				});
				if (!messages) throw error;
				log.warn('Prompt overflowed the context window; retrying compacted', {
					providerId: target.providerId,
					modelId: target.modelId,
					promptTokens,
					contextLength
				});
				const result = await model.doStream({
					...params,
					prompt: messages as unknown as typeof params.prompt
				});
				return { ...result, stream: watch([], result.stream.getReader(), promptTokens) };
			};

			let result: StreamResult;
			try {
				result = await doStream();
			} catch (e) {
				if (!isContextOverflowError(e)) throw e;
				return retry(e);
			}
			const reader = result.stream.getReader();
			const { head, overflow } = await peek(reader);
			if (overflow) {
				reader.cancel().catch(() => undefined);
				return retry(overflow.error);
			}
			return { ...result, stream: watch(head, reader, promptTokens) };
		}
	};
}

export function withContextOverflowRetry(
	model: LanguageModel,
	opts: OverflowRetryOptions
): LanguageModel {
	if (typeof model === 'string') return model;
	return wrapLanguageModel({
		model: model as WrappableModel,
		middleware: contextOverflowMiddleware(opts)
	}) as unknown as LanguageModel;
}
