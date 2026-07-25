# AGENTS.md

## Hard rules

- Never start the dev server yourself — ask the user to run it (or confirm it's already running).
- Keep the codebase clean and well-architected; be conservative with bigger changes.
- Use async `fs` methods (`node:fs/promises`) in new code.
- Package manager is **pnpm** (`.npmrc` has `engine-strict=true`; `pnpm-workspace.yaml` pins build allowlist for `better-sqlite3`/`esbuild`). Don't use npm/yarn for installs.

## Stack

SvelteKit 2 + Svelte 5 (runes forced for all non-`node_modules` files, see `vite.config.ts`), Tailwind 4, better-sqlite3, better-auth, Vercel AI SDK (`ai` v7 + `@ai-sdk/svelte`), adapter-node, PWA via `@vite-pwa/sveltekit`.

## Commands

- Typecheck: `pnpm check` (runs `svelte-kit sync` + `svelte-check`) — run this and `pnpm lint` after changes.
- Unit tests: `pnpm test:unit` (vitest, watch). Run once: `pnpm test:unit -- --run`.
  - Two projects: `server` (node env, `src/**/*.{test,spec}.ts`) and `client` (**browser mode** via Playwright chromium, only `src/**/*.svelte.{test,spec}.ts`). Filter with `-t "name"` or a file path; `--project server` to target one.
  - `expect` is configured with `requireAssertions: true` — every test must assert.
- E2E: `pnpm test:e2e` — builds + previews the prod bundle (port 4173), testMatch `**/*.e2e.ts`.
- Full suite: `pnpm test` = unit once + e2e.

## Architecture

- App = "Chatty", self-hosted AI chat. Entry wiring (startup side effects) lives in `src/hooks.server.ts`: seeds builtin agents, fails interrupted agent runs / proxy requests, starts agent event dispatcher, scheduler, and daily jobs.
- All server-only code is under `src/lib/server/` (db, auth, agents, chat, llm, mcp, memory, proxy, skills, tools, workspaces). Never import it from client code (`$lib` shared modules must stay server-free).
- DB: better-sqlite3, WAL + foreign_keys + busy_timeout set in `src/lib/server/db/index.ts`. Migrations are plain numbered SQL files in `migrations/`, applied automatically at startup by `src/lib/server/db/migrate.ts` (tracked in `_migrations`). To change the schema, add the next numbered `NNNN_name.sql`; don't edit applied files.
  - Exception: `migrations/0002_better-auth.sql` is generated — regenerate via `npx @better-auth/cli migrate --config scripts/auth-cli.ts -y` then `node scripts/dump-auth-schema.mjs`.
- Env config is validated with zod in `src/lib/server/config.ts`; all env access goes through `config`. `vite.config.ts` calls `process.loadEnvFile()` for non-test modes, so `.env` is loaded by Vite itself — tests run without `.env`.
- Runtime data dirs at repo root (gitignored, do not touch): `data/` (sqlite), `memory/`, `skills/`, `documents/`, `workspaces/` (per-agent sandbox dirs named `agent-<agentId>-<runId>`).

## CI / release

- No PR CI. `.github/workflows/docker-image.yml` only builds/pushes a GHCR image on push or `v*` tags; the tag version is injected into `package.json` during the workflow.

## Reference docs in repo

- `requirements.md`, `implementation-plan.md`, `todos.md` — historical/planning docs; verify against code before trusting.
