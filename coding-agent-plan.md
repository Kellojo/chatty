# Coding Agent Platform — Implementation Plan

## Architecture

### Three components

```
┌─ Chatty ──────────────────────────────────────────────┐
│                                                        │
│  Regular chats: streamText (unchanged)                 │
│  All agents: dispatch to Runner                        │
│  MCP Gateway: expose tools to OpenCode                 │
│  Proxy: serve LLM for OpenCode                         │
│  UI: conversations, streaming, settings                │
│                                                        │
└──────────────────────┬─────────────────────────────────┘
                       │ HTTP
                       ▼
┌─ Runner (systemd service, Docker socket) ──────────────┐
│                                                        │
│  Manages persistent OpenCode containers                │
│  One container per agent run                            │
│  Routes Chatty sessions → OpenCode API                  │
│  Docker isolation, local or remote host                 │
│                                                        │
└──────────────────────┬─────────────────────────────────┘
                       │ docker exec / docker API
                       ▼
┌─ Container (ephemeral, per agent run) ──────────────────┐
│                                                        │
│  OpenCode V2 in server mode (opencode serve)             │
│  Workspace = /workspace (bind-mount, shared store)       │
│  State = /root/.local/share/opencode (persistent)        │
│  MCP → Chatty's gateway (HTTP)                           │
│  LLM → Chatty's proxy (temp API key)                     │
│  All tools isolated: shell, fs, git                       │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### What runs where

| Concern | Engine | Why |
|---|---|---|
| Regular chat | Chatty `streamText` | No Docker needed for casual use |
| Persona agents | **OpenCode** (Runner) | Isolation, coding tools, unified engine |
| Coding agents | **OpenCode** (Runner) | Same as persona — coding is just a persona |
| Scheduled agents | **OpenCode** (Runner) | Container overhead irrelevant (<1/min) |
| Event agents | **OpenCode** (Runner) | Same — rare triggers |
| MCP tools | Chatty MCP Gateway | Expose memory, search, fs, etc. to OpenCode |
| LLM calls | Chatty Proxy | OpenCode uses it via temp API key |

### Regular chats stay on Chatty's streamText

Regular chat conversations need instant responses and zero Docker dependency. They
continue using Chatty's existing `streamText` + MCP tool system. The runner is
optional — only needed for agent execution.

---

## Phase 1 — Database Schema

### Migration `0030_coding_config.sql`

```sql
-- Per-user git service config — exactly one service active at a time.
-- PAT is AES-256-GCM encrypted (same scheme as provider keys in crypto.ts).
CREATE TABLE coding_config (
  user_id        TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  service        TEXT NOT NULL,               -- 'github' | 'gitea' | 'gitlab' | 'bitbucket'
  url            TEXT NOT NULL,               -- service base URL
  pat_encrypted  TEXT NOT NULL,               -- encrypted personal access token
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
```

### Migration `0031_coding_repos.sql`

```sql
CREATE TABLE coding_repos (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                  -- user-chosen label
  clone_url   TEXT NOT NULL,                  -- https://github.com/owner/repo.git
  repo_owner  TEXT NOT NULL,
  repo_name   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(user_id, clone_url)
);
```

### Migration `0032_coding_workspaces.sql`

```sql
CREATE TABLE coding_workspaces (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  repo_id         TEXT REFERENCES coding_repos(id) ON DELETE SET NULL,  -- NULL = blank project
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_run_id    TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  runner_id       TEXT,                        -- which runner handled this (informational)
  container_id    TEXT,                        -- current Docker container ID (NULL when stopped)
  opencode_data_path TEXT,                     -- path to OpenCode's persistent data dir for this run
  opencode_session_id TEXT,                    -- OpenCode session ID (set after first prompt)
  branch          TEXT NOT NULL,
  base_branch     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  pr_url          TEXT,
  preview_url     TEXT,
  preview_port    INTEGER,
  workspace_path  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

### Migration `0033_api_key_expiry.sql`

```sql
-- Extend api_keys to support temporary keys for agent runs.
-- agent_run_id links to the agent run that owns this key.
-- expires_at caps the lifetime (max 24h, enforced at auth time).
ALTER TABLE api_keys ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
```

### No schema changes for existing tables

- `agents` — no change; coding uses `trigger_type = 'persona'`
- `conversations` — reuse `kind = 'agent-run'`, `mode = 'agent'`
- `role_defaults` — new `coding` role is just convention
- `api_keys` — two new columns added above; no new table needed

---

## Phase 2 — Runner

### What the runner is

A separate Node process (~300 lines) that runs as a systemd service (or Docker
container on bare-metal). It owns the Docker socket and manages persistent
OpenCode containers. Chatty never touches Docker.

### Runner lifecycle

```
1. Chatty needs agent execution → POST /api/runners/start
2. Runner creates Docker container with OpenCode:
   - Mounts workspace dir (working tree) and OpenCode data dir (persistent session state)
3. Runner generates opencode.json in the workspace:
   - Provider: points at Chatty proxy with temp API key
   - MCP: Chatty's MCP gateway URL
   - Model: from agent config
4. Runner starts OpenCode in server mode
5. Runner exposes the container's port (mapped to host)
6. Chatty connects @opencode/client → container
7. Chatty creates (or reconnects to) the session, sends prompt, streams events
8. Agent completes → Chatty calls POST /api/runners/stop
9. Runner stops + removes container (state survives in the mounts)
```

### Resume (continuation)

Resuming a conversation is *starting the same mount* again, then continuing the
existing session instead of creating a new one:

```
POST /api/runners/start  { workspaceId, dataPath, resume: true, ... }
  → runner recreates the container with the same two mounts
  → Chatty does GET /session/:id  (id from coding_workspaces.opencode_session_id)
  → then  POST /session/:id/message  { parts: [...] }  to continue
```

There is no export/import. The session lives in OpenCode's data dir on shared
storage; a fresh container pointing at it is indistinguishable from the original.

### Multiple runners and shared storage

`runner_id` and `container_id` in `coding_workspaces` are **informational only** —
Chatty never hard-routes a resume back to the same runner. Instead, the workspace
dir and OpenCode data dir live on a **shared volume** (NFS or a volume plugin) that
every runner mounts. Any runner can recreate any conversation's container and resume
its session. This makes resume work regardless of which runner handled the original
run, and survives a runner going down or being replaced.

### Runner API

```
POST /api/runners/start    { workspaceId, workspacePath, dataPath, agentId, modelConfig, mcpGatewayUrl, proxyUrl, proxyToken }
  → { containerId, port, opencodeUrl }

DELETE /api/runners/stop    { workspaceId }
  → { success }

GET  /api/runners/status   { workspaceId }
  → { status, containerId, port }

GET  /api/runners/health
  → { status: "ok", labels: ["gaming-pc"] }
```

### Container spec

```dockerfile
# chatty-runner-image (built once, reused)
FROM node:22-alpine
RUN apk add --no-cache git openssh
RUN npm install -g opencode@latest
# OpenCode handles everything: shell, fs, git, LLM calls
```

```bash
# Runner creates:
docker create --name coding-<id> \
  --network bridge \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  -v ${workspacePath}:/workspace \
  -v ${dataPath}:/root/.local/share/opencode \
  -w /workspace \
  -p ${port}:4096 \
  chatty-runner-image \
  opencode serve --port 4096 --hostname 0.0.0.0
```

Two persistent mounts per run, both on the shared store:

- `${workspacePath}` → `/workspace` — the agent's working tree (git clone)
- `${dataPath}` → `/root/.local/share/opencode` — OpenCode's sessions/messages DB

Because both live on shared storage, the container can be started fresh later and
OpenCode will find its prior sessions. `docker rm -f` on stop is safe — state lives
outside the container.

### Docker-in-Docker? No.

The runner runs as a regular process with access to the host's Docker socket
(via `docker.sock` mount if the runner itself is in Docker, or directly if running
on bare metal). It spawns sibling containers — not containers inside containers.

If Chatty runs in Docker and the runner is on the same host, they're siblings:

```
┌─ Host Docker Daemon ────────────────────────────┐
│                                                  │
│  ┌─ Chatty Container ──┐  ┌─ Runner Container ──┐│
│  │  No Docker socket    │  │  Has Docker socket  ││
│  │  HTTP → runner:3001  │  │  spawns agent       ││
│  └──────────────────────┘  │  containers         ││
│                            └─────────────────────┘│
│                                      │            │
│                    ┌─────────────────┘            │
│                    ▼                              │
│  ┌─ Agent Container ──────────────────────────┐  │
│  │  OpenCode (opencode serve)                  │  │
│  │  /workspace = host bind mount (shared)      │  │
│  │  ~/.local/share/opencode = shared (persist) │  │
│  │  MCP → Chatty gateway                       │  │
│  │  LLM → Chatty proxy                         │  │
│  └─────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## Phase 3 — Chatty MCP Gateway

### `src/lib/server/mcp/gateway.ts`

Exposes Chatty's existing MCP servers as HTTP endpoints that OpenCode can consume.
Each enabled MCP server gets an endpoint:

```
GET  /api/mcp/:serverName/          → Server info
GET  /api/mcp/:serverName/sse       → SSE connection (OpenCode's MCP transport)
POST /api/mcp/:serverName/messages  → MCP JSON-RPC messages
```

OpenCode connects to `http://chatty:3000/api/mcp/fs`, `http://chatty:3000/api/mcp/memory`, etc.
as remote MCP servers configured in the generated `opencode.json`.

The gateway authenticates requests using the temporary API key (same `aic_` key
used for the proxy). The key's scopes include `mcp:read`/`mcp:write`, validated
by `resolveApiKeyIdentity()`. The key is auto-deleted when the agent run completes.

### What tools OpenCode gets

| MCP Server | Tools | Notes |
|---|---|---|
| `fs` | fs_read, fs_write, fs_list | Scoped to workspace dir |
| `memory` | search_memory, read_concept, create_concept, ... | User's memory bundle |
| `chat-search` | search_chats, read_chat | Agent can reference past conversations |
| `webfetch` | webfetch | Fetch external URLs |
| `websearch` | websearch | SearXNG integration |
| `datetime` | datetime | Current time, timezone |
| `code-exec` | code_exec | JS sandbox (isolated-vm) |
| `weather` | weather | Open-Meteo |
| `math` | math | Math evaluation |
| `image` | image | Image generation |

Additional coding-specific tools stay in OpenCode (shell, git) — those are
OpenCode's built-in tools and don't need Chatty's MCP.

---

## Phase 4 — Chatty: Agent Dispatch

### `src/lib/server/agents/runner.ts` changes

The existing `startAgentRun()` becomes a dispatch layer. Instead of running
`streamText` locally, it:

```typescript
export async function startAgentRun(input: StartAgentRunInput): Promise<StartedAgentRun> {
  // 1. Create conversation + agent_run row (unchanged)
  const conversation = createConversation(...);
  const run = createAgentRun(...);

  // 2. Create workspace dir (unchanged)
  const workspaceDir = ensureAgentWorkspace(agent.id, run.id);

  // 3. Create temporary API key for this run
  const { rawKey } = await createApiKey(db, {
    userId: input.userId,
    label: `agent-run:${run.id}`,
    scopes: ['proxy:chat', 'mcp:read', 'mcp:write'],
    agentRunId: run.id,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });

  // 4. Dispatch to runner
  const { containerId, port } = await runner.start({
    workspaceId: workspaceDir,
    workspacePath: path.resolve(config.WORKSPACES_VOLUME, workspaceDir),
    dataPath: path.resolve(config.CODING_DATA_VOLUME, run.id, 'opencode'),
    agentConfig: {
      systemPrompt: agent.system_prompt,
      model: { providerId: agent.provider_id, modelId: agent.model_id },
      skillNames: JSON.parse(agent.skill_names),
    },
    mcpGatewayUrl: `http://localhost:${config.PORT}/api/mcp`,
    proxyUrl: `http://localhost:${config.PORT}/api/v1`,
    proxyToken: rawKey,    // temp API key — valid for proxy + MCP gateway
  });

  // 5. Connect OpenCode client to container
  const opencode = OpenCode.make({ baseUrl: `http://localhost:${port}` });
  const session = await opencode.session.create({
    location: { directory: '/workspace' },
  });

  // 6. Send instructions as first message
  const stream = opencode.session.prompt({
    sessionID: session.id,
    text: instructions,
  });

  // 7. Stream OpenCode events → conversation messages
  const done = streamAgentEvents(stream, conversation.id, run.id, db, input.userId);

  // 8. Cleanup on completion
  done.then(() => runner.stop(workspaceDir));

  return { run, done };
}

// Continuation (resume) — called from /api/coding/workspaces/[id]/continue
export async function continueAgentRun(input: { workspaceId: string; text: string }) {
  const ws = getCodingWorkspace(db, input.workspaceId);   // has opencode_session_id, paths

  // 1. Ensure a container is running (recreate if it was stopped/expired)
  const { port } = await runner.start({
    workspaceId: ws.workspaceDir,
    workspacePath: ...,
    dataPath: ws.opencode_data_path,     // SAME data dir → session history persists
    resume: true,
    ...
  });

  // 2. Reconnect the OpenCode client and continue the existing session
  const opencode = OpenCode.make({ baseUrl: `http://localhost:${port}` });
  const stream = opencode.session.prompt({
    sessionID: ws.opencode_session_id,    // existing session, not a new create()
    text: input.text,
  });

  // 3. Stream events into the same conversation as before
  await streamAgentEvents(stream, ws.conversation_id, ws.agent_run_id, db, ws.user_id);
}
```

### What changes in `agent/runner.ts`

| Change | Scope |
|---|---|
| Remove `streamText` block | ~60 lines removed |
| Add runner dispatch | ~40 lines added |
| Add OpenCode event streaming | ~80 lines new (`streamAgentEvents`) |
| SSE events (agent.run.started/progress/finished) | Kept, published during streaming |

### `streamAgentEvents` — translating OpenCode → Chatty

```typescript
async function streamAgentEvents(
  stream: AsyncIterable<OpenCodeEvent>,
  conversationId: string,
  runId: string,
  db: Db,
  userId: string,
): Promise<void> {
  for await (const event of stream) {
    switch (event.type) {
      case 'message':
        // OpenCode assistant message → Chatty message
        upsertMessage(db, conversationId, {
          role: 'assistant',
          parts: event.parts,
          status: event.final ? 'complete' : 'partial',
        });
        break;

      case 'tool_call':
        // OpenCode tool invocation → Chatty tool result
        upsertToolResult(db, conversationId, event);
        break;

      case 'error':
        // Report to agent_run
        break;
    }

    publishServerEvent(userId, {
      type: 'agent.run.progress',
      agentId: run.agentId,
      runId: run.id,
    });
  }

  finishAgentRun(db, runId, 'success');
  publishServerEvent(userId, {
    type: 'agent.run.finished',
    agentId: run.agentId,
    runId: run.id,
    status: 'success',
  });
}
```

---

## Phase 5 — Git Config & PR

### `src/lib/server/coding/config.ts`

Same as before — centralized git service config with encrypted PAT.

### `src/lib/server/coding/repos.ts`

Lightweight repo references — auth resolved at runtime from config.

### `src/lib/server/coding/service.ts`

Thin orchestration for coding agents. When a coding persona is selected from
the UI, this handles the repo setup and dispatches to the runner.

```typescript
export async function startCodingRun(input: StartCodingRunInput) {
  // 1. Load git config
  const config = getCodingConfig(db, input.userId);
  const repo = input.repoId ? getRepo(db, input.repoId, input.userId) : null;

  // 2. Determine agent from persona selection
  const agent = getAgent(db, input.agentId);

  // 3. Build coding-specific instructions
  const instructions = buildCodingInstructions({
    task: input.task,
    repoUrl: repo?.clone_url,
    repoName: repo?.name,
    branch: `chatty/coding-${Date.now().toString(36)}`,
    baseBranch: repo?.defaultBranch ?? 'main',
  });

  // 4. Dispatch to runner (same as any agent)
  const { run, done } = await startAgentRun({
    agentId: agent.id,
    trigger: 'chat',           // persona trigger from UI
    userId: input.userId,
    instructions,
  });

  // 5. Inject git credentials into workspace
  //    Write .gitconfig with extraHeader or GIT_CONFIG env
  //    so OpenCode can clone/push without seeing PAT
  injectGitCredentials(path.join(config.WORKSPACES_VOLUME, run.workspaceDir), config, repo);

  // 6. Track in coding_workspaces
  createCodingWorkspace(db, { ... });

  // 7. Monitor for PR creation
  done.then(() => checkAndLinkPr(db, workspaceId));

  return { conversationId: run.conversationId, runId: run.id };
}
```

### `src/lib/server/coding/pr.ts`

REST API calls per service. When the agent creates a PR (via `git push` + REST
call), Chatty detects the PR URL in the conversation output or via a dedicated
OpenCode form and stores it in `coding_workspaces.pr_url`.

The PR creation itself happens inside OpenCode — the agent runs `git push` and
uses `gh` CLI or direct REST calls to create the PR. Since OpenCode has network
access inside its container, it can make these calls directly. Alternatively,
Chatty exposes a lightweight `create_pr` MCP tool that OpenCode can call.

---

## Phase 6 — Human Input Flow (OpenCode Forms)

OpenCode has a **built-in Forms system**. When the agent needs input, it creates
a form via `POST /api/session/{id}/form`. The session pauses automatically — no
hacks, no polling, no custom MCP tools needed.

### Flow

```
1. Agent runs in OpenCode container:
   "I need to know which auth library to use."

2. OpenCode creates a form:
   POST /api/session/{id}/form
   → {
       title: "Auth library choice",
       fields: [
         { key: "library", type: "multiselect", title: "Library",
           options: [{value:"bcrypt",label:"bcrypt"},{value:"argon2",label:"argon2"}] },
         { key: "reason", type: "string", title: "Why?", required: false }
       ]
     }
   → Form state: pending
   → Session PAUSED — OpenCode waits

3. Chatty detects form-created event (via OpenCode SSE):
   - Renders inline form in conversation UI
   - coding_workspaces.status = 'awaiting_input'

4. User fills in form → Chatty calls OpenCode:
   POST /api/session/{id}/form/{formId}/reply
   → { answer: { library: "argon2", reason: "More secure against GPU attacks" } }

   → Form state: answered → Session RESUMES
   → OpenCode continues where it left off
```

### How Chatty subscribes to form events

Chatty already connects to OpenCode's event stream to receive messages. Form
events arrive through the same stream. Chatty detects `form.created` events and
renders the form inline in the conversation timeline (between messages).

### Form types OpenCode supports

| Type | Usage |
|---|---|
| `string` | Free-text response, optional validation (email, URI, regex pattern) |
| `number` | Numeric input with min/max |
| `integer` | Whole number with min/max |
| `boolean` | Yes/no checkbox |
| `multiselect` | One or more options from a list (dropdown/checkboxes) |
| `external` | Custom URL — Chatty can provide a custom form renderer |

### Requesting input vs OpenCode forms

Since OpenCode has native forms, we don't need a `request_input` MCP tool.
OpenCode already knows how to ask for user input when it's stuck or needs
clarification. The form system handles everything: structured input fields,
validation, conditional display, and session pause/resume.

---

## Phase 6b — Resuming Conversations

### Short-term resume (same container)

When a form pauses the agent and the user responds within the container's lifetime:

- The persistent Docker container stays alive
- OpenCode holds the session in memory
- User's form reply arrives → OpenCode continues instantly
- No container restart, no session rebuild

### Long-term resume (days later — genuine resume)

This is now a **real resume**, not a new task. Because the workspace and OpenCode's
data dir both live on shared storage, a conversation can be continued by any runner
at any time:

```
Day 1: User starts coding task → container created → agent runs, creates PR
       → container stopped (state in shared mounts), conversation in Chatty DB

Day 3: User opens the conversation, types a follow-up
       → Chatty sees no live container, calls POST /api/runners/start { resume: true }
       → runner recreates a container with the SAME two mounts
       → Chatty GET /session/:id (from coding_workspaces.opencode_session_id)
       → POST /session/:id/message { parts: [user's follow-up] }
       → OpenCode continues with full history + the workspace still on disk
       → Follow-up lands in the SAME conversation thread in the UI
```

The agent understands context from the actual session history (messages, tool
calls, compaction state) plus the working tree, git log, and any PR. No
export/import, no "describe the task again."

### When resume is a new task instead

The user can still **choose** a fresh start rather than resume — e.g. they want a
different base branch, a different agent, or a clean slate. That's just the normal
"start" path (new workspace, new session, new conversation). Resume is the default
for "ask a follow-up in an existing conversation."

### Paused / interrupted recovery

```
Scenario: Agent paused or was interrupted, container gone (TTL expired, server restart, crash)

1. hooks.server.ts on startup / content on container-loss:
   - Find coding_workspaces with status = 'awaiting_input' or 'running'
   - Their session state is safe in the shared OpenCode data dir
   - Attempt resume: start container with same mounts → check session/status

2. Form TTL:
   - Pending forms have a configurable TTL (default: 24h)
   - Expired form → cancel the form, mark run 'needs_attention'
   - User can re-prompt the same session to continue anyway

3. Container TTL (idle, no form):
   - Idle containers are stopped after a configurable TTL to free resources
   - Stopping is cheap because state is in the mounts — resume recreates it
```

### What "resume" means from Chatty's perspective

| Scenario | Action |
|---|---|
| Form pending, <TTL | User fills form → container resumes |
| Form pending, >TTL | Form cancelled; same session can be re-prompted |
| Completed, user follows up | Resume: recreate container → `POST /session/:id/message` |
| Server restart while running | Restart container with same mounts → check status, continue |
| User wants fresh start | Normal start (new workspace, new session) |
| Different repo/agent/base branch | Normal start (new conversation) |

### No session export/import needed

The OpenCode session is stored in the per-run data dir on shared storage. A fresh
container mounting that dir is byte-for-byte identical to the original, so resume
and continuation are seamless. The same dir also holds the working tree, so the
agent sees uncommitted work, git state, and prior session history together.

---

## Phase 7 — API Routes

### Git Config & Repos

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/coding/config` | Get config (without PAT) |
| `PUT` | `/api/coding/config` | Create/update config |
| `DELETE` | `/api/coding/config` | Remove config |
| `GET` | `/api/coding/repos` | List repos |
| `POST` | `/api/coding/repos` | Add repo |
| `PATCH` | `/api/coding/repos/[id]` | Update repo name |
| `DELETE` | `/api/coding/repos/[id]` | Remove repo |

### Coding Runs

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/coding/start` | Start coding task (new workspace + session) |
| `POST` | `/api/coding/workspaces/[id]/continue` | Resume or continue an existing session |
| `GET` | `/api/coding/workspaces` | List workspaces |
| `GET` | `/api/coding/workspaces/[id]` | Workspace detail |
| `POST` | `/api/coding/workspaces/[id]/form-reply` | Submit OpenCode form answer |
| `POST` | `/api/coding/workspaces/[id]/stop` | Stop run |

### MCP Gateway (OpenCode consumes these)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/mcp/:server/sse` | SSE transport |
| `POST` | `/api/mcp/:server/messages` | JSON-RPC messages |

### Preview

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/coding/preview/[id]/[...path]` | Preview proxy |

---

## Phase 8 — UI Changes

### Settings → Coding (`/settings/coding/`)

Same as before — git service config + connected repos.

### Agent Editor (`/agents/[id]`)

Add a preset button: "Coding Agent" — pre-fills system prompt with coding
persona template.

### Chat Drafting Page (`/`)

The existing persona selector includes coding agents. When a coding persona
is selected:

- Repo picker appears (connected repos + "Blank project")
- Placeholder changes to "Describe what to build…"
- Send button routes to `/api/coding/start` instead of `/api/conversations`

### Conversation View (`/chat/[id]`)

When the conversation is linked to a coding workspace (join `coding_workspaces` on
`agent_run_id` or `conversation_id`):

**Header bar**: Shows repo name • branch • PR badge (clickable) • Preview button.
Data loaded from `coding_workspaces` row in `+page.server.ts`.

**Tool calls**: OpenCode tool invocations stream as Chatty messages. `ToolCallCard`
renders them exactly as it does for chat tool calls. No special handling needed.

**Forms**: When OpenCode creates a form (`form.created` event), a new `FormCard`
component renders inline between messages. On submit, Chatty forwards the reply to
OpenCode's `POST /api/session/{id}/form/{formId}/reply`. The form ID and session ID
are stored in `coding_workspaces` so the form survives page reloads.

**Resume after days**: When a user types a follow-up into a completed or idle
coding conversation, Chatty resumes the session (see Phase 6b) rather than starting
a new task:

- No live container → Chatty calls the runner to recreate it with the same mounts
- The follow-up goes to `POST /session/:id/message` on the existing session
- Response appears as the next message in the same thread

**Fresh start button**: The header also offers a "New task" button for the same
repo when the user wants a clean slate (new workspace, new session, new
conversation) instead of resuming.

### Agent Run View (`/agents/[id]/runs/[runId]`)

Shows agent run transcripts (existing page). For coding runs, additionally shows
repo, branch, PR badge, and preview button. Same data source as conversation view.

### Sidebar

Coding conversations get a `Code2` (Lucide) icon prefix.

---

## Phase 9 — Cleanup

- **Workspace GC**: `jobs.ts` removes stale coding workspaces + cleans up runner
  containers via runner API
- **Startup recovery**: `hooks.server.ts` marks running agent runs as failed,
  instructs runner to stop orphaned containers, and deletes temporary API keys
  for failed runs (`DELETE FROM api_keys WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE status IN ('running'))`)
- **API key GC**: `jobs.ts` deletes expired keys
  (`DELETE FROM api_keys WHERE expires_at IS NOT NULL AND expires_at < ?`)
- **Runner health**: Chatty pings runner health endpoint; warns in UI if runner
  is unavailable (agents disabled, chats still work)

---

## File Inventory

### New Files

```
runner/                              # Separate directory, not in Chatty source
├── package.json                     # Deps: @opencode/client, dockerode
├── Dockerfile
├── src/
│   ├── index.ts                     # Main server (express/fastify)
│   ├── container.ts                 # Docker container lifecycle
│   ├── config.ts                    # opencode.json generation
│   └── routes.ts                    # /start, /stop, /status, /health

src/lib/server/coding/
├── config.ts                        # Git service config CRUD
├── config.spec.ts
├── repos.ts                         # Repo references
├── repos.spec.ts
├── service.ts                       # Coding orchestration
├── service.spec.ts
├── pr.ts                            # PR creation (REST calls)
└── pr.spec.ts

src/lib/server/mcp/
├── gateway.ts                       # MCP HTTP gateway for OpenCode
└── gateway.spec.ts

src/lib/server/db/repo/
├── coding-config.ts
├── coding-config.spec.ts
├── coding-repos.ts
├── coding-repos.spec.ts
├── coding-workspaces.ts
└── coding-workspaces.spec.ts

src/routes/api/
├── coding/config/+server.ts
├── coding/repos/+server.ts
├── coding/repos/[id]/+server.ts
├── coding/start/+server.ts
├── coding/workspaces/+server.ts
├── coding/workspaces/[id]/+server.ts
├── coding/workspaces/[id]/continue/+server.ts
├── coding/workspaces/[id]/form-reply/+server.ts
├── coding/workspaces/[id]/stop/+server.ts
├── coding/preview/[id]/[...path]/+server.ts
├── mcp/[server]/sse/+server.ts
└── mcp/[server]/messages/+server.ts

src/routes/(app)/settings/coding/
├── +page.svelte
└── +page.server.ts

migrations/
├── 0030_coding_config.sql
├── 0031_coding_repos.sql
├── 0032_coding_workspaces.sql
└── 0033_api_key_expiry.sql
```

### Modified Files

```
src/lib/types.ts                            # + CodingConfig, CodingRepo, CodingWorkspace types
src/lib/server/agents/runner.ts             # Replace streamText with runner dispatch
src/lib/server/jobs.ts                      # + gcCodingWorkspaces + token cleanup
src/lib/server/config.ts                    # + RUNNER_URL, CODING_DATA_VOLUME (env vars)
src/hooks.server.ts                         # Runner health check on startup
src/routes/(app)/+page.svelte               # Coding persona → repo picker + task input
src/routes/(app)/+page.server.ts            # + coding config + repos data
src/lib/components/app/ChatView.svelte      # + coding header, PR badge, preview btn
src/lib/components/app/MessageTimeline.svelte  # + OpenCode form rendering
src/lib/components/app/FormCard.svelte      # NEW: renders OpenCode forms inline
src/routes/(app)/settings/+layout.svelte    # + "Coding" nav item
src/lib/components/app/AgentEditor.svelte   # + "Coding Agent" preset button (optional)
```

---

## Agent Execution — Final Summary

```
┌─ Agent triggers ─────────────────────────────────────┐
│                                                      │
│  Persona (user selects from dropdown)                 │
│  Schedule (cron: every 30min)                        │
│  Event (memory.changed, chat.created)                 │
│                                                      │
│  All → agents/runner.ts → dispatch to Runner          │
│                                                      │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌─ Runner ─────────────────────────────────────────────┐
│  Docker: persistent container per agent run           │
│  OpenCode V2 in server mode                           │
│  ┌─────────────────────────────────────────────────┐ │
│  │  LLM → Chatty Proxy (temp API key)              │ │
│  │  Tools → Chatty MCP Gateway (HTTP transport)     │ │
│  │  Shell/Git → OpenCode builtins (in container)    │ │
│  │  Files → /workspace (bind-mount, shared store)   │ │
│  │  State → /root/.local/share/opencode (persistent)│ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  Events streamed → Chatty → conversation messages     │
│  Resume = recreate container, continue same session   │
└──────────────────────────────────────────────────────┘

Regular chats: Chatty streamText (unchanged, no Docker needed)
```

OpenCode handles the agent loop (tool use, shell, git, thinking). Chatty
handles orchestration (conversations, messaging, auth, settings, proxy).
The runner provides Docker isolation and can run on a different machine.

A conversation can be resumed at any time — the workspace and OpenCode's session
state both live on shared storage, so a fresh container mounting them continues
the same session (`POST /session/:id/message`).

---

## Implementation Order

| Phase | Scope | Size |
|---|---|---|
| 1 | Database schema (4 migrations) | Small |
| 2 | Runner (Docker + OpenCode container lifecycle) | Large |
| 3 | Chatty MCP Gateway (HTTP transport for existing servers) | Medium |
| 4 | Agent dispatch (replace streamText with runner dispatch) | Large |
| 5 | Git config + repos + PR creation | Medium |
| 6 | Human input flow | Small |
| 7 | API routes | Medium |
| 8 | UI (settings, drafting, conversation, sidebar) | Large |
| 9 | Cleanup & polish | Small |