# Plan: Image generation tool

## Architecture fit

Tools in Chatty are all MCP-based: builtin in-process servers in `src/lib/server/mcp/servers/`, seeded as rows in `mcp_servers` (`transport='builtin'`), connected per-request by `clientManager.ts`, and exposed through `buildTools()` in `src/lib/server/tools/registry.ts:29`. The chat service (`src/lib/server/chat/service.ts:280`) builds tools and streams via `streamText`; tool calls render through `ToolCallCard.svelte`. Attachments live on disk under `workspaces/<conversationId>/attachments/` with rows in the `attachments` table, served at `/api/conversations/[id]/attachments/[attachmentId]`. `MessageTimeline.svelte:163-179` already renders image `file` parts inline.

Plan: a new builtin **`image` MCP server** with a `generate_image` tool, backed by the AI SDK's `generateImage` (confirmed exported in installed `ai@7.0.36`), saving results as conversation attachments and emitting them as `file` parts so they render inline.

## Steps

### 1. Migration — seed the server

- New `migrations/0023_image_mcp.sql`:
  `INSERT INTO mcp_servers (id, name, transport, builtin) VALUES ('builtin-image', 'image', 'builtin', 1);`
  (mirrors `0017_websearch_mcp.sql`).

### 2. Image model resolution (server)

- `ai` v7's `generateImage({ model, prompt, ... })` needs an `ImageModel`. Extend `src/lib/server/llm/registry.ts` with `resolveImageModel(ref)` that builds an image-capable client from the provider row:
  - `openai-compatible` providers → `createOpenAICompatible(...).imageModel(modelId)`
  - `anthropic` → throw a clear "not supported" error (no image generation).
- Model config: reuse the `models` table — add an `'image'` capability string (capabilities is a free-form JSON array, `models.ts:100`). Admins register an image model on a provider and mark it with the `image` capability. No schema change.
- Settings keys (via `settings` table, like websearch):
  - `image.model_ref` = `<providerId>:<modelId>` (chosen from models with the `image` capability)
  - `image.default_size` (e.g. `1024x1024`)
  - `image.max_images_per_call` (default 1, cap 4) — passed to `generateImage` as `maxImagesPerCall`, which controls SDK request batching (useful for custom/local models with unknown per-call limits)

### 3. Builtin MCP server — `src/lib/server/mcp/servers/image.ts`

- `createImageServer(ctx: CallerContext)` registering tool `generate_image` with input:

  ```ts
  {
    prompt: string,
    size?: string,                      // "{width}x{height}", e.g. "1024x1024"
    aspectRatio?: string,               // "{w}:{h}", e.g. "16:9" — pass only one of size/aspectRatio
    n?: number,                         // capped by image.max_images_per_call setting
    quality?: 'standard' | 'hd',        // optional, mapped into providerOptions (OpenAI-style)
    style?: 'vivid' | 'natural'         // optional, mapped into providerOptions (OpenAI-style)
  }
  ```

  Note: `size` and `aspectRatio` are mutually exclusive — the schema description must tell the model to pass only the one the configured model supports (many providers, e.g. Flux/Imagen, use aspect ratios instead of sizes). `seed` is intentionally not exposed.

- Handler:
  1. Read settings; if no image model configured → `err('image generation not configured — ask an admin to pick a model in Settings → Images')`.
  2. `resolveImageModel(ref)` then `generateImage({ model, prompt, size, aspectRatio, n, maxImagesPerCall, providerOptions })`.
  3. Persist each image: `ensureAttachmentsDir(ctx.conversationId)` (`workspaces.ts:21`), write `<uuid>-generated.png` with `node:fs/promises`, `createAttachment(db, { kind: 'image', path, mime, sha256 })` (`attachments.ts:13`).
  4. Result text includes: count + filenames, `revisedPrompt` from `providerMetadata` when present, and any `warnings` from the response (e.g. ignored params).
  5. Catch `NoImageGeneratedError` (`NoImageGeneratedError.isInstance(e)`) → clean `err('image generation failed: ...')`.
  6. Return the MCP text content plus a JSON payload `{ attachmentIds: [...] }` that the chat layer translates into file parts (MCP image content parts don't survive the AI SDK tool-result → UI-message pipeline as first-class file parts).
- Register in `src/lib/server/mcp/servers/index.ts` `BUILTIN_SERVERS`.

### 4. Surface images as `file` parts in the chat stream

- In `src/lib/server/chat/service.ts`, after each `streamText` step (or in `onStepFinish`), inspect tool results from the `image` server. For each `attachmentIds` payload:
  - look up each attachment row,
  - `linkAttachmentsToMessage(db, assistantMessageId, ids)` (`attachments.ts:28`),
  - `writer.write({ type: 'file', url: '/api/conversations/<id>/attachments/<attId>', mediaType: row.mime })` so `MessageTimeline.svelte:165` renders it inline.
- `ToolCallCard` keeps showing the textual result; the image renders below it as a regular image part. Parts persist to `messages.parts`, so images survive reload.

### 5. Settings UI — `src/routes/(app)/settings/images/`

- New `+page.svelte` / `+page.server.ts` modeled on `settings/search/`: dropdown of models with the `image` capability (grouped by provider), default size input, max-images-per-call input, save → `settings` keys. Add nav entry in `settings/+layout.svelte`.
- Models page (`settings/models/+page.svelte:333`): add `'image'` to the selectable capability checkboxes.
- `aspectRatio` / `quality` / `style` stay per-call tool inputs, not settings.

### 6. Tool metadata

- `src/lib/tool-meta.ts`: `generate_image: { label: 'Generate image', server: 'image' }`.

### 7. Tests

- `src/lib/server/mcp/servers/image.spec.ts`: handler returns `err` when unconfigured; on success (mock `generateImage`) writes file + attachment row and returns payload; respects `n` cap; surfaces `warnings` / `revisedPrompt` in result text; maps `NoImageGeneratedError` to `err`; uses `ctx.conversationId` dir.
- `src/lib/server/tools/registry.spec.ts`: extend "builds tools from all enabled builtin servers" to include `image` when seeded.
- `src/lib/server/chat/service.spec.ts`: tool-result → `file` part emission + `linkAttachmentsToMessage` wiring.
- All tests must assert (`requireAssertions: true`).

## Key decisions / tradeoffs

- **Attachment + `file` part over markdown link**: durable, rendered by existing UI branch, survives reload since parts persist.
- **Provider scope**: v1 supports `openai-compatible` providers only via AI SDK `imageModel`; Anthropic providers return a clear error.
- **No schema change** for models — the `image` capability reuses the existing JSON array column; only the `mcp_servers` seed migration is new.
- **Tool inputs vs settings**: `prompt`, `size`/`aspectRatio`, `n`, `quality`, `style` are per-call tool inputs (model-controlled); only the model ref, default size, and max images per call are admin settings. `seed`, `headers`, `abortSignal` are not exposed.
- **Not in scope**: language-model image output (`result.files` via `generateText`, e.g. gemini image models) — separate feature.

## Files touched (new in **bold**)

- **`migrations/0023_image_mcp.sql`**
- `src/lib/server/llm/registry.ts` (+ `mapped.ts` types)
- **`src/lib/server/mcp/servers/image.ts`**, `src/lib/server/mcp/servers/index.ts`
- `src/lib/server/chat/service.ts`
- **`src/routes/(app)/settings/images/+page.{svelte,server.ts}`**, `settings/+layout.svelte`, `settings/models/+page.svelte`
- `src/lib/tool-meta.ts`
- **`src/lib/server/mcp/servers/image.spec.ts`**, `tools/registry.spec.ts`, `chat/service.spec.ts`

## Verification

- `pnpm check`, `pnpm lint`
- `pnpm test:unit -- --run`
- Manual: configure an image model in Settings → Images, ask the chat to "generate an image of X", confirm inline render + reload persistence + attachment row on disk.

## Open questions

- Should `generate_image` be callable in agent mode? (Default: yes, it's an MCP server; agents can allowlist it out.)
- Should agent-run images attach to the agent's workspace instead of a conversation? (Default: follow the same `ctx.conversationId` / `workspaceDir` split the `fs` server uses.)
