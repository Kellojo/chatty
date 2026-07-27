# Chatty

Self-hosted AI chat with multi-agent workflows, MCP tools, memory, and an OpenAI-compatible proxy. Built with SvelteKit 2 + Svelte 5, Tailwind 4, better-sqlite3, better-auth, and the Vercel AI SDK.

## Features

- Chat with LLMs (OpenAI, Anthropic, LM Studio, OpenRouter, and more via the Vercel AI SDK)
- Multi-step **agent runs** with tool use (MCP servers, code execution, file system, web search/fetch)
- **Memory** with full-text search for long-term context
- **Skills** system to extend agent capabilities
- **Workspaces** — per-agent sandboxed directories
- **OpenAI-compatible proxy** (`/v1/chat/completions`) for external tools
- Auth via better-auth: password, OIDC, or OIDC-only mode
- PWA support

## Quick start (Docker Compose)

```yaml
services:
  app:
    image: ghcr.io/kellojo/chatty:latest
    container_name: chatty
    restart: unless-stopped
    environment:
      DATABASE_PATH: /data/ai-chat.db
      MEMORY_VOLUME: /memory
      DOCUMENTS_VOLUME: /documents
      WORKSPACES_VOLUME: /workspaces
      APP_SECRET: ${CHATTY_APP_SECRET}
      TZ: Europe/Berlin
      ORIGIN: https://ai.example.com
      #ENABLE_SIGNUP: false
      #ENABLE_PASSWORD_LOGIN: false
      #OIDC_ONLY: true
      #OIDC_ISSUER: https://auth.example.com
      #OIDC_CLIENT_ID: ${CHATTY_CLIENT_ID}
      #OIDC_CLIENT_SECRET: ${CHATTY_CLIENT_SECRET}
      #OIDC_SCOPES: openid profile email
    volumes:
      - ./data:/data
      - ./memory:/memory
      - ./documents:/documents
      - ./workspaces:/workspaces
      - ./skills:/skills
```

> **Note:** `APP_SECRET` must be at least 16 characters. `OIDC_ONLY=true` requires all three `OIDC_*` variables.

## Environment variables

| Variable                  | Default                 | Description                                         |
| ------------------------- | ----------------------- | --------------------------------------------------- |
| `DATABASE_PATH`           | `./data/ai-chat.db`     | SQLite database path                                |
| `MEMORY_VOLUME`           | `./memory`              | Memory storage directory                            |
| `SKILLS_VOLUME`           | `./skills`              | Skills directory                                    |
| `DOCUMENTS_VOLUME`        | `./documents`           | Documents directory                                 |
| `WORKSPACES_VOLUME`       | `./workspaces`          | Agent workspaces directory                          |
| `APP_SECRET`              | —                       | Secret for session encryption (min 16 chars)        |
| `TZ`                      | `UTC`                   | Timezone                                            |
| `ORIGIN`                  | —                       | Public origin URL (e.g. `https://chat.example.com`) |
| `PORT`                    | `3000`                  | Server port                                         |
| `ENABLE_SIGNUP`           | `true`                  | Allow user registration                             |
| `ENABLE_PASSWORD_LOGIN`   | `true`                  | Allow password login                                |
| `OIDC_ONLY`               | `false`                 | Disable password login, require OIDC                |
| `OIDC_ISSUER`             | —                       | OIDC issuer URL                                     |
| `OIDC_CLIENT_ID`          | —                       | OIDC client ID                                      |
| `OIDC_CLIENT_SECRET`      | —                       | OIDC client secret                                  |
| `OIDC_SCOPES`             | `openid profile email`  | OIDC scopes                                         |
| `LM_STUDIO_BASE_URL`      | `http://localhost:1234` | LM Studio endpoint                                  |
| `AGENT_MAX_STEPS`         | `25`                    | Max steps per agent run                             |
| `MAX_ATTACHMENT_SIZE_MB`  | `50`                    | Max upload size                                     |
| `WORKSPACE_GC_DAYS`       | `30`                    | Days before workspace cleanup                       |
| `SETTINGS_MCP_WRITE`      | `false`                 | Allow MCP write tools                               |
| `AUTO_PROMOTE_FIRST_USER` | `true`                  | First user becomes admin                            |

## Development

```sh
pnpm install
pnpm dev
```

## Commands

| Command                   | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `pnpm check`              | Typecheck (`svelte-kit sync` + `svelte-check`) |
| `pnpm lint`               | Prettier + ESLint                              |
| `pnpm test:unit`          | Unit tests (vitest, watch)                     |
| `pnpm test:unit -- --run` | Unit tests once                                |
| `pnpm test:e2e`           | E2E tests (build + preview + Playwright)       |
| `pnpm test`               | Full suite (unit + e2e)                        |
