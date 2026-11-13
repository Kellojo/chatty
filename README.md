# Chatty

Self-hosted AI chat with multi-agent workflows, MCP tools, memory, and an OpenAI-compatible proxy. Built with SvelteKit 2 + Svelte 5, Tailwind 4, better-sqlite3, better-auth, and the Vercel AI SDK.

## Features

- Chat with LLMs (OpenAI, Anthropic, LM Studio, OpenRouter, and more via the Vercel AI SDK)
- Multi-step **agent runs** with tool use (MCP servers, code execution, file system, web fetch)
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
      SKILLS_VOLUME: /skills
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

| Variable                        | Default                | Description                                                                        |
| ------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_PATH`                 | `./data/ai-chat.db`    | SQLite database path                                                               |
| `MEMORY_VOLUME`                 | `./memory`             | Memory storage directory                                                           |
| `SKILLS_VOLUME`                 | `./skills`             | Skills directory                                                                   |
| `DOCUMENTS_VOLUME`              | `./documents`          | Documents directory                                                                |
| `WORKSPACES_VOLUME`             | `./workspaces`         | Agent workspaces directory                                                         |
| `APP_SECRET`                    | —                      | Secret for session encryption (min 16 chars)                                       |
| `TZ`                            | `UTC`                  | Timezone                                                                           |
| `ORIGIN`                        | —                      | Public origin URL (e.g. `https://chat.example.com`)                                |
| `PORT`                          | `3000`                 | Server port                                                                        |
| `ENABLE_SIGNUP`                 | `true`                 | Allow user registration                                                            |
| `ENABLE_PASSWORD_LOGIN`         | `true`                 | Allow password login                                                               |
| `OIDC_ONLY`                     | `false`                | Disable password login, require OIDC                                               |
| `OIDC_ISSUER`                   | —                      | OIDC issuer URL                                                                    |
| `OIDC_CLIENT_ID`                | —                      | OIDC client ID                                                                     |
| `OIDC_CLIENT_SECRET`            | —                      | OIDC client secret                                                                 |
| `OIDC_SCOPES`                   | `openid profile email` | OIDC scopes                                                                        |
| `AGENT_MAX_STEPS`               | `25`                   | Max steps per agent run                                                            |
| `MAX_ATTACHMENT_SIZE_MB`        | `50`                   | Max upload size                                                                    |
| `WORKSPACE_GC_DAYS`             | `30`                   | Days before workspace cleanup                                                      |
| `SETTINGS_MCP_WRITE`            | `false`                | Allow MCP write tools                                                              |
| `CONVERSATION_AUTO_SETTLE_DAYS` | `7`                    | Idle days before a chat is auto-settled (hidden from sidebar); `0` disables        |
| `AGENT_QUESTION_TTL_DAYS`       | `7`                    | Days before an agent's unanswered question is dismissed; `0` disables              |
| `AGENT_RUN_CHAT_RETENTION_DAYS` | `30`                   | Days before settled agent-run chats you never replied to are deleted; `0` disables |
| `ALLOW_PRIVATE_NETWORK_FETCH`   | `false`                | Let agent fetch tools reach localhost, LAN and metadata addresses                  |
| `AUTO_PROMOTE_FIRST_USER`       | `true`                 | First user becomes admin                                                           |

## Deployment

**Run exactly one instance (one container / replica).** Chatty is not designed for horizontal scaling: active chat streams, agent run controllers (used to stop runs), the server-sent event bus, the agent scheduler and the daily/hourly background jobs all live in process memory, and the SQLite database sits on a local volume. A second instance would not see the other's streams or events, could not stop its runs, and would fire scheduled agents twice. When upgrading, stop the old container before starting the new one (e.g. a `Recreate` rollout strategy) rather than running both side by side.

Admins can add `stdio` MCP servers, which run the configured command inside the Chatty container/host. Only add commands you trust.

### MCP servers with OAuth sign-in

Remote (HTTP/SSE) MCP servers can use OAuth instead of a fixed token: set **Authentication → OAuth** on the server under Settings → MCP servers. Every user then connects their own account under **Settings → Connected apps**, and the assistant uses the server's tools as that user. Tokens are stored per user, encrypted with the app secret, and refreshed automatically.

Chatty finds the authorization server through the MCP server's protected resource metadata and registers itself, in this order:

1. a client you registered by hand (client ID and optional secret on the server),
2. a **client ID metadata document**: Chatty's client ID is `<ORIGIN>/api/mcp-oauth/client-metadata.json` (needs a public `https` `ORIGIN`),
3. dynamic client registration, when the authorization server offers it.

The redirect URL to allow is `<ORIGIN>/api/mcp-oauth/callback`. Set `ORIGIN` so these URLs are stable. With Pocket ID, add the client ID URL to **Allowed metadata document URLs** and enable **Allow all metadata document clients** on the API, or register Chatty as an OIDC client with that redirect URL.

## Data, backups and restore

All state lives in the mounted volumes:

| Volume        | Contents                                                                                       | Back up? |
| ------------- | ---------------------------------------------------------------------------------------------- | -------- |
| `/data`       | SQLite database (users, chats, agents, settings, encrypted secrets) and `.secret` (see below)  | **Yes**  |
| `/memory`     | Memory bundles (markdown files); the search index in the database is rebuilt from them on boot | **Yes**  |
| `/skills`     | User and shared skills                                                                         | **Yes**  |
| `/documents`  | Uploaded documents                                                                             | **Yes**  |
| `/workspaces` | Agent sandbox directories, garbage-collected after `WORKSPACE_GC_DAYS`                         | Optional |

Provider keys, MCP tokens and OAuth tokens are encrypted with `APP_SECRET`. If `APP_SECRET` is not set, Chatty generates one and stores it in `/data/.secret`. **Keep the secret with your backups**: a database restored with a different secret loses every stored provider key and token, and they have to be re-entered.

### Backing up

The simplest consistent backup is to stop the container, copy the volumes, and start it again:

```sh
docker compose stop app
tar czf chatty-backup-$(date +%F).tar.gz data memory skills documents
docker compose start app
```

To back up without downtime, take an online snapshot of the database (copying the `.db` file of a running instance can produce a corrupt copy, because SQLite runs in WAL mode), then copy the other volumes:

```sh
docker exec chatty node -e "require('better-sqlite3')('/data/ai-chat.db').backup('/data/backup.db').then(() => console.log('ok'))"
```

Then archive `data/backup.db`, `data/.secret` (if used), `memory`, `skills` and `documents`.

### Restoring

1. Stop the container.
2. Replace the volume contents with the backup. When restoring an online snapshot, rename `backup.db` to `ai-chat.db` and delete any leftover `ai-chat.db-wal` / `ai-chat.db-shm` files.
3. Make sure `APP_SECRET` (or `/data/.secret`) matches the one in use when the backup was taken.
4. Start the **same or a newer** Chatty version as the one that took the backup. A newer version migrates the database on boot.

## Upgrading

1. **Back up first** (see above). Database migrations cannot be undone.
2. Pull the new image and recreate the container: `docker compose pull && docker compose up -d`. Stop the old container before starting the new one; never run two versions against the same volumes.
3. On boot, Chatty applies any new numbered migrations from `migrations/` in order, each inside a transaction, and records them in the `_migrations` table. A migration that fails is rolled back, and Chatty cannot open its database until the problem is fixed; the logged error names the failing migration file. To recover, restore the backup or go back to the previous image.

**Downgrading.** Migrations are forward-only; there are no down migrations. An older version starts against a newer database but may fail on the changed schema. To roll back, restore the backup taken before the upgrade and run the previous image.

**Stability.** From 1.0 on, upgrades within the same major version keep the database, the volume layout and the environment variables backward compatible: existing installs keep working after pulling a new image. Breaking changes to any of those only ship in a new major version, with notes in the release.

> **Older installs:** earlier versions of this README did not set `SKILLS_VOLUME`, so skills were stored inside the container (`/app/skills`) rather than in the `/skills` volume, and were lost when the container was recreated. Before adding `SKILLS_VOLUME: /skills`, copy any skills out of the running container: `docker cp chatty:/app/skills/. ./skills/` (skip the `defaults` folder).

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
