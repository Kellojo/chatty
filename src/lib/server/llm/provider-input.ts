import { z } from 'zod';

/** A new provider as the API accepts it (Settings → Providers and onboarding). */
export const providerCreateSchema = z
	.object({
		name: z.string().min(1).max(100),
		type: z.enum(['anthropic', 'openai-compatible']),
		baseUrl: z.url().nullish(),
		apiKey: z.string().min(1).nullish(),
		enabled: z.boolean().optional()
	})
	.refine((input) => input.type !== 'openai-compatible' || Boolean(input.baseUrl), {
		message: 'baseUrl is required for openai-compatible providers'
	});

export type ProviderCreateInput = z.infer<typeof providerCreateSchema>;
