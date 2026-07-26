import type {
	ImageModelV4,
	ImageModelV4CallOptions,
	ImageModelV4File,
	ImageModelV4Result
} from '@ai-sdk/provider';

type ImageModel = ImageModelV4;
type ImageModelCallOptions = ImageModelV4CallOptions;
type ImageModelResult = ImageModelV4Result;

interface OpenRouterImageResponse {
	data?: { b64_json?: string; media_type?: string }[];
	error?: { message?: string };
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// OpenRouter's dedicated Image API is `POST {base}/images` (JSON), which the
// AI SDK's openai-compatible provider does not use (it hardcodes
// /images/generations + /images/edits). This wrapper implements ImageModel
// against OpenRouter's actual endpoint, including `input_references` for
// image-to-image editing.
export function createOpenRouterImageModel(options: {
	provider: string;
	modelId: string;
	baseURL: string;
	apiKey?: string;
	headers?: Record<string, string>;
}): ImageModel {
	const base = options.baseURL.replace(/\/$/, '');
	return {
		specificationVersion: 'v4',
		provider: options.provider,
		modelId: options.modelId,
		maxImagesPerCall: 10,
		async doGenerate(call: ImageModelCallOptions): Promise<ImageModelResult> {
			const body: Record<string, unknown> = {
				model: options.modelId,
				prompt: call.prompt,
				n: call.n
			};
			if (call.size) body.size = call.size;
			if (call.aspectRatio) body.aspect_ratio = call.aspectRatio;
			if (call.seed != null) body.seed = call.seed;

			const warnings: ImageModelResult['warnings'] = [];
			if (call.mask) {
				warnings.push({ type: 'unsupported', feature: 'mask' });
			}

			if (call.files && call.files.length > 0) {
				body.input_references = call.files.map((f: ImageModelV4File) => {
					if (f.type === 'url') {
						return { type: 'image_url', image_url: { url: f.url } };
					}
					const base64 =
						typeof f.data === 'string' ? f.data : Buffer.from(f.data).toString('base64');
					return {
						type: 'image_url',
						image_url: { url: `data:${f.mediaType};base64,${base64}` }
					};
				});
			}

			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				...options.headers,
				...Object.fromEntries(
					Object.entries(call.headers ?? {}).filter((e): e is [string, string] => e[1] != null)
				)
			};
			if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

			const res = await fetch(`${base}/images`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: call.abortSignal
			});

			const responseHeaders: Record<string, string> = {};
			res.headers.forEach((v, k) => {
				responseHeaders[k] = v;
			});

			const text = await res.text();
			let json: OpenRouterImageResponse;
			try {
				json = JSON.parse(text) as OpenRouterImageResponse;
			} catch {
				throw new Error(`OpenRouter image API returned invalid JSON (HTTP ${res.status})`);
			}
			if (!res.ok) {
				throw new Error(json.error?.message ?? `OpenRouter image API error (HTTP ${res.status})`);
			}

			const images = (json.data ?? [])
				.map((d) => d.b64_json)
				.filter((b): b is string => typeof b === 'string' && b.length > 0);
			if (images.length === 0) {
				throw new Error('OpenRouter image API returned no images');
			}

			return {
				images,
				warnings,
				response: {
					timestamp: new Date(),
					modelId: options.modelId,
					headers: responseHeaders
				},
				usage:
					json.usage != null
						? {
								inputTokens: json.usage.prompt_tokens,
								outputTokens: json.usage.completion_tokens,
								totalTokens: json.usage.total_tokens
							}
						: undefined
			};
		}
	};
}
