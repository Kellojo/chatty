# Chatty

Self-hosted AI chat with multi-agent workflows, MCP tools, memory, and an OpenAI-compatible proxy. Built with SvelteKit 2 + Svelte 5, Tailwind 4, better-sqlite3, better-auth, and the Vercel AI SDK.

## Features

- Chat with LLMs (OpenAI, Anthropic, LM Studio, OpenRouter, and more via the Vercel AI SDK)
- Multi-step **agent runs** with tool use (MCP servers, code execution, file system, web fetch)
- **Memory** with full-text search for long-term context
- **Skills** system to extend agent capabilities
- **Workspaces** — per-agent sandboxed directories
- **OpenAI-compatible proxy** (`/v1/chat/completions`, `/v1/audio/transcriptions`, `/v1/audio/speech`) for external tools
- **Voice**: dictate messages and have replies read aloud, with a speech-to-text / text-to-speech model or the browser's built-in voice
- **MCP gateway** (`/api/mcp`) — use Chatty's tools (memory, past chats, skills, agents, …) from Claude Code, Codex or OpenCode
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

> **Note:** The image already points `DATABASE_PATH` and the `*_VOLUME` variables at `/data`, `/memory`, `/skills`, `/documents` and `/workspaces`, so you only need to set them to use different paths. `APP_SECRET` must be at least 16 characters. `OIDC_ONLY=true` requires all three `OIDC_*` variables.

## Environment variables

| Variable                        | Default                | Description                                                                             |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_PATH`                 | `./data/ai-chat.db`    | SQLite database path (Docker image: `/data/ai-chat.db`)                                 |
| `MEMORY_VOLUME`                 | `./memory`             | Memory storage directory (Docker image: `/memory`)                                      |
| `SKILLS_VOLUME`                 | `./skills`             | Skills directory (Docker image: `/skills`)                                              |
| `DOCUMENTS_VOLUME`              | `./documents`          | Documents directory (Docker image: `/documents`)                                        |
| `WORKSPACES_VOLUME`             | `./workspaces`         | Agent workspaces directory (Docker image: `/workspaces`)                                |
| `APP_SECRET`                    | —                      | Secret for session encryption (min 16 chars)                                            |
| `TZ`                            | `UTC`                  | Timezone                                                                                |
| `ORIGIN`                        | —                      | Public origin URL (e.g. `https://chat.example.com`)                                     |
| `PORT`                          | `3000`                 | Server port                                                                             |
| `ENABLE_SIGNUP`                 | `true`                 | Allow user registration                                                                 |
| `ENABLE_PASSWORD_LOGIN`         | `true`                 | Allow password login                                                                    |
| `OIDC_ONLY`                     | `false`                | Disable password login, require OIDC                                                    |
| `OIDC_ISSUER`                   | —                      | OIDC issuer URL                                                                         |
| `OIDC_CLIENT_ID`                | —                      | OIDC client ID                                                                          |
| `OIDC_CLIENT_SECRET`            | —                      | OIDC client secret                                                                      |
| `OIDC_SCOPES`                   | `openid profile email` | OIDC scopes                                                                             |
| `AGENT_MAX_STEPS`               | `25`                   | Max model steps (tool rounds + final answer) per reply or run, unless set per chat      |
| `MAX_ATTACHMENT_SIZE_MB`        | `50`                   | Max upload size                                                                         |
| `WORKSPACE_GC_DAYS`             | `30`                   | Days before workspace cleanup                                                           |
| `CONVERSATION_AUTO_SETTLE_DAYS` | `7`                    | Idle days before a chat is auto-settled (hidden from sidebar); `0` disables             |
| `AGENT_QUESTION_TTL_DAYS`       | `7`                    | Days before an agent's unanswered question is dismissed; `0` disables                   |
| `AGENT_RUN_CHAT_RETENTION_DAYS` | `30`                   | Days before settled agent-run chats you never replied to are deleted; `0` disables      |
| `ALLOW_PRIVATE_NETWORK_FETCH`   | `false`                | Let agent fetch tools reach localhost, LAN and metadata addresses                       |
| `AUTO_PROMOTE_FIRST_USER`       | `true`                 | First user becomes admin                                                                |
| `ARTIFICIAL_ANALYSIS_API_KEY`   | —                      | Key for model Intelligence Index scores; overrides the key saved in Settings → Services |
| `SEARXNG_URL`                   | —                      | SearXNG URL for the `web_search` tool; overrides the one saved in Settings → Services   |
| `BRAVE_SEARCH_API_KEY`          | —                      | Brave Search API key for `web_search`; overrides the key saved in Settings → Services   |
| `PERPLEXITY_API_KEY`            | —                      | Perplexity API key for `web_search`; overrides the key saved in Settings → Services     |

Model Intelligence Index scores come from [Artificial Analysis](https://artificialanalysis.ai) (free API key, 100 requests a day). Save the key in **Settings → Services**, where it is stored encrypted, or set `ARTIFICIAL_ANALYSIS_API_KEY`. Scores are fetched only when you save the key, sync a provider's models (at most once an hour) or click Refresh; nothing runs in the background. A refresh costs 2–3 requests.

### Web search

Models get a `web_search` tool (web results, or news with `type: "news"`) once a search provider is configured in **Settings → Services**; without one, the tool isn't offered at all. Three providers are supported:

- **SearXNG**: a self-hosted metasearch engine. Enter its base URL (e.g. `http://searxng:8080`) or set `SEARXNG_URL`. Since the admin configures it, it may be on localhost or a private network without `ALLOW_PRIVATE_NETWORK_FETCH`; only link-local/metadata addresses are refused. Chatty talks to its JSON API, which SearXNG disables by default: add `json` to `search.formats` in its `settings.yml`, otherwise saving fails with HTTP 403.
- **Brave Search API**: save an [API key](https://api-dashboard.search.brave.com/app/keys) (stored encrypted) or set `BRAVE_SEARCH_API_KEY`. Brave also adds a `search_places` tool (restaurants, shops, sights… with address, rating, opening hours and coordinates) via its Place Search API, which is part of the Search plan.
- **Perplexity Search API**: save an [API key](https://www.perplexity.ai/account/api/keys) (stored encrypted) or set `PERPLEXITY_API_KEY`. It returns ranked web results, not generated answers, and has no news search, so news searches use the other providers.

Each is checked with a test search before it's saved, and env vars override what's saved in the app. Results come back as the same source cards as `fetch`, so citations look alike.

With several providers connected, **Settings → Services → Web search** picks how a search uses them, and shows the resulting order:

- **Combined** (default): every provider is searched at once and the results are merged into one list, de-duplicated by URL and ranked so pages that several providers found come first. Each result notes which providers found it. A round waits at most 10 s, and once one provider has found something the others get 3 s more; providers that are too slow are left out of that answer.
- **Fallback**: one provider answers each search, starting with the one set with **Make default**; the next is only tried when it fails.

Paid APIs bill every search they take part in, so Combined costs more than Fallback. Set a provider to **Backup only** to search it only when no other provider answers (in Fallback, it's tried last). If every provider is Backup only, they're all searched normally.

A SearXNG sidecar for the compose file above:

```yaml
services:
  # app: … as above, plus SEARXNG_URL: http://searxng:8080
  searxng:
    image: searxng/searxng:latest
    container_name: searxng
    restart: unless-stopped
    environment:
      SEARXNG_SECRET: ${SEARXNG_SECRET}
    volumes:
      - ./searxng:/etc/searxng # settings.yml goes here
```

and at least this in `./searxng/settings.yml`:

```yaml
use_default_settings: true
server:
  limiter: false # only Chatty calls it, from inside the compose network
search:
  formats:
    - html
    - json
```

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

### MCP gateway

`<ORIGIN>/api/mcp` serves Chatty's MCP servers to other MCP clients (Streamable HTTP, stateless). Clients authenticate with an API key that has the `mcp:use` scope, and the tools act as that key's user, with their memory, chats and OAuth sign-ins. Each key has its own tool access, picked per server or per tool when creating or editing it under **Settings → API**. A server with all its tools picked also gets tools it adds later. A key that was never edited gets the default servers: everything except `fs`, `code-exec`, `math` and `datetime` (coding agents have their own versions), `subagents` and `coding` (they only work inside a Chatty conversation), `agents` (agent runs use each agent's own tools, so they reach past the key's picks; turn it on only for clients you fully trust), and `chat-search` and `memory` (they hand your past chats and notes to the client; keys created before this change keep them, and Settings → API points those keys out). Private chats, notes and documents are never served through the gateway, whatever a key allows. Gateway calls never run with admin rights, even for an admin's keys. The **MCP gateway** tab shows the keys with access, which keys reach each server, call counts and setup snippets.

Clients can also **sign in with OAuth** instead of taking a key: Claude Code and Claude.ai only need the endpoint URL. They discover Chatty's OAuth server (`/.well-known/oauth-protected-resource`, dynamic client registration, PKCE) and open Chatty in the browser, where you approve them and pick their tools. Each approval becomes an API key marked with the client's name. Edit it to change its tools, or delete it to sign the client out. Set `ORIGIN` to Chatty's public URL so the URLs in the OAuth metadata match what clients use. Claude.ai connects from Anthropic's servers, so Chatty has to be reachable from the internet over HTTPS for it.

For Claude Code, including coding agents started through T3 Code (run this on the T3 host, then run `/mcp` in Claude Code and choose Authenticate):

```sh
claude mcp add --scope user --transport http chatty <ORIGIN>/api/mcp
```

Or with an API key instead of signing in:

```sh
claude mcp add --scope user --transport http chatty <ORIGIN>/api/mcp --header "Authorization: Bearer aic_..."
```

## Private data

An admin turns on **Settings → Private data → Allow private data** to let users mark chats, memory notes, documents and agents as private (off by default; turning it off only hides the controls, so what is already private stays private). **The rule:** private data only reaches providers an admin marked **Can process private data** (Settings → Providers), so a chat holding private data only ever runs on those models. Tools are not restricted.

- **Trusted providers.** Tick _Can process private data_ in a provider's create or edit dialog. Any provider type qualifies; the dialog hints when a URL looks local and warns when private data would go to a public host. Nothing is trusted after an upgrade, so nothing changes until you opt in.
- **What is private.** A chat you lock (composer or chat menu), a chat started from a private agent, notes marked _Private_ in the memory editor (admins only for shared notes), and files under `documents/<user>/private/`. **A chat becomes private permanently** once it reads private data (a private note, a private chat, a private agent's result); it says so in the chat. Making it public again needs a confirmation, and text an untrusted provider already received can't be recalled.
- **Making chats private.** _New chats are private_ (Settings → Conversation) starts every new chat locked; the lock can still be turned off per chat. To make an existing chat private, use _Make private…_ in its menu, or _Select…_ in the chat list to make several private at once (coding chats can't be). The dialog can replace the title with a placeholder and lists the memory notes written after a memory run read the chat, to mark them private too (best effort). What models already received and push notifications already sent can't be recalled. Settings → Providers asks once whether existing LM Studio and Ollama providers may process private data.
- **What a private chat can do.** It only runs on trusted models: the model picker greys out the rest, mapping fallbacks to untrusted providers are skipped, and title, compaction and summaries use a trusted model (the role model if trusted, else the chat's own) or a placeholder title. Image and speech tools only use trusted providers, agents it starts run privately (so on trusted models only), and a hand-off draft is written by a trusted model. All other tools work as usual, so anything a tool sends out (a web fetch URL, an MCP server, a coding task or hand-off) is up to you and the model. Notes it writes are private, and files it writes into documents go to `documents/<user>/private/`. Dictation and read-aloud only use trusted speech models or on-device browser voices; push notifications say "Private chat" without the title.
- **Automatic marking.** When the _Decisions_ role (Settings → Defaults) is a model on a trusted provider, every memory note a chat or memory run saves is checked for personal information (names, contact details, birth dates, specific people such as family members) and for health, money, secrets and personal matters, and marked private if it has any (it says why in the memory editor, where you can turn it off). It only ever adds the flag; without a trusted Decisions model, nothing is checked.
- **Chats that can reach an untrusted model** never see private items: memory and chat search hide them ("N private results hidden"). A mapping with one untrusted target counts as untrusted. The _strict memory privacy_ setting hides memory and past chats from untrusted models altogether.
- **API callers** (`/v1/*`, decisions, the MCP gateway) own their payload, so they are not private unless they use a mapping marked _Trusted providers only_ (Settings → Mappings).

**Not covered:** what a trusted provider does with the data (trusting a cloud provider, or a LAN proxy that forwards to one, means trusting where it sends data); anyone with shell or database access (private data is stored in plain text); data pasted into a non-private chat; the user's own browser extensions. What tools send out (web fetch, web search, `fs_curl`, MCP servers, coding tasks); `ALLOW_PRIVATE_NETWORK_FETCH` still only decides which addresses the fetch tools may reach. Admins can see in Usage → Requests which models a private chat used and when, but not its content. Providers are shared across the instance, so the admin's trust choice applies to everyone's private data, and private shared notes are readable by every user's trusted chats.

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

**Bundled MCP servers regrouped (migration `0081`).** The `settings` server is removed, `wait` is now a tool of `datetime`, `math` and `datetime` are always loaded, and `run_subagent` and the coding tools moved out of `agents` into the new `subagents` and `coding` servers. API keys that granted `settings` or `wait` lose those grants; grant `datetime` instead if a key needs `wait`. `SETTINGS_MCP_WRITE` no longer has any effect and can be removed from your environment.

**Downgrading.** Migrations are forward-only; there are no down migrations. An older version starts against a newer database but may fail on the changed schema. To roll back, restore the backup taken before the upgrade and run the previous image.

**Stability.** From 1.0 on, upgrades within the same major version keep the database, the volume layout and the environment variables backward compatible: existing installs keep working after pulling a new image. Breaking changes to any of those only ship in a new major version, with notes in the release.

> **Storage paths now set by the image.** The image sets `DATABASE_PATH=/data/ai-chat.db` and `MEMORY_VOLUME`, `SKILLS_VOLUME`, `DOCUMENTS_VOLUME` and `WORKSPACES_VOLUME` to `/memory`, `/skills`, `/documents` and `/workspaces`. Variables you set yourself still win, so installs that set them see no change. If you left one unset, the app used the matching path under `/app` (e.g. `/app/data`, `/app/skills`) and will now look in the root path instead. Before upgrading, either set the variable to the old path, or move your mount or data to the new one. Data that only lived inside the container can be copied out with e.g. `docker cp chatty:/app/skills/. ./skills/` (skip the `defaults` folder). Earlier versions of this README did not set `SKILLS_VOLUME`, so check skills in particular. If the database ends up in a different place than its data, Chatty starts on an empty database, and with signup enabled the first person to register becomes admin.

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
