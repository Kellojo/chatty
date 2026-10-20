# Coding Agent Platform — Implementation Plan

## Architecture

### Two components, GitHub Actions model

```
┌─ Chatty (control plane) ──────────────────────────────────────────┐
│                                                                     │
│  Regular chats: streamText (unchanged)                              │
│  Agent sessions: dispatch to chatty-agent runner                    │
│  MCP Gateway: expose tools to harnesses                            │
│  Proxy: serve LLM for harnesses                                    │
│  UI: conversation view + session dashboard + git panel              │
│                                                                     │
│  Existing agent system (streamText agents): REMOVED                 │
│  All agents run on chatty-agent runners in Docker containers        │
│                                                                     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ WebSocket (persistent, runner→Chatty)
                                │ "Any jobs for me?"
                                ▼
┌─ chatty-agent (compute plane) ──────────────────────────────────────┐
│  Headless daemon. Runs on YOUR machine — laptop, server, VM.        │
│                                                                     │
│  Connects to Chatty via WebSocket. Registers capabilities.          │
│  Receives jobs, spawns harnesses in Docker containers.              │
│  Streams events back to Chatty for storage + display.               │
│                                                                     │
│  Multiple runners can connect to one Chatty instance.               │
│  Chatty routes jobs to the best available runner.                   │
└─────────────────────────────────────────────────────────────────────┘
```

### Comparison with previous plan

| Concern | Previous plan | New plan |
|---|---|---|
| Runner | Standalone service, shared storage, same Docker host | chatty-agent daemon, any machine, no shared storage |
| Runner ↔ Chatty | Chatty pushes via HTTP to known URL | Runner connects via WebSocket, polls for jobs |
| Agent execution | Chatty's streamText for non-coding, Runner for coding | ALL agents run on chatty-agent runners |
| Existing agent system | Kept (persona, scheduled, HTTP triggers) | **Removed entirely** — replaced by chatty-agent sessions |
| Container isolation | Docker on same host as Chatty | Docker on runner's host (any machine) |
| Multi-harness | OpenCode only | OpenCode (Phase 1), Claude Code (Phase 2), Pi (Phase 3) |
| Workspaces | Shared NFS volume | Ephemeral per-session dirs on runner |
| Session resume | Recreate container with same mounts | Re-clone repo, continue OpenCode session |
| Harness config | Runner generates opencode.json | Runner generates opencode.json with Chatty proxy + MCP gateway |
| Git | Runner handles git ops | Runner handles git ops, streams diffs to Chatty for display |

---

## Phase 0 — Rip Out Existing Agent System

Before building anything new, remove the old agent infrastructure that's being replaced.

### What gets removed

```
src/lib/server/agents/
├── builtin.ts          # Builtin agent definitions → removed
├── builtin.spec.ts
├── runner.ts           # streamText-based agent dispatch → removed
├── runner.spec.ts
├── scheduler.ts        # Cron-based agent scheduler → removed
├── scheduler.spec.ts
├── events.ts           # Agent SSE events → removed
├── events.spec.ts

src/routes/(app)/agents/                          # Agent editor UI → removed
src/routes/api/agents/[id]/run/+server.ts         # HTTP trigger → removed

migrations/  (drop agents, agent_runs tables)     # New migration to drop

DB: DROP TABLE agent_runs, DROP TABLE agents       # or mark deprecated
```

### What stays (repurposed)

- `conversations` table — reused for agent sessions (a session has a conversation)
- `messages` table with `tool_calls`, `tool_results` — stays, stores harness messages
- `api_keys` table — stays, used for runner keys + temp harness proxy keys
- `src/lib/server/workspaces.ts` — workspaces concept stays, now managed by runner
- MCP gateway — stays, extended to serve harnesses
- LLM proxy — stays, harnesses use it via temp API keys

### What the rip-out migration looks like

```sql
-- migration: 0034_remove_legacy_agents.sql
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS agent_skill_bindings;

-- Remove agent-related columns from api_keys if they exist
-- (these were planned but may not be created yet)
```

---

## Phase 1 — Chatty: Runner Registry & Connection Endpoint

### Database

```sql
-- migration: 0035_runners.sql
CREATE TABLE runners (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,               -- "gaming-pc", "cloud-vm-1"
  labels          TEXT,                         -- JSON: ["docker","linux","gpu"]
  harnesses       TEXT NOT NULL,                -- JSON: ["opencode@2.1.3"]
  status          TEXT NOT NULL DEFAULT 'offline',  -- online | offline
  last_heartbeat  INTEGER,
  version         TEXT,                         -- chatty-agent version
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- migration: 0036_runner_sessions.sql
CREATE TABLE runner_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  runner_id       TEXT REFERENCES runners(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  job_id          TEXT UNIQUE,
  label           TEXT,                         -- user-given name
  project_url     TEXT NOT NULL,                -- git clone URL
  project_label   TEXT,                         -- display name for the project
  harness         TEXT NOT NULL,                -- "opencode" | "claude-code" | "pi"
  model           TEXT,
  branch          TEXT NOT NULL,
  base_branch     TEXT NOT NULL DEFAULT 'main',
  status          TEXT NOT NULL DEFAULT 'queued',
    -- queued | starting | active | awaiting_input | completed | errored | archived
  auto_commit     INTEGER NOT NULL DEFAULT 0,
  pr_url          TEXT,
  exit_code       INTEGER,
  error_message   TEXT,
  created_at      INTEGER NOT NULL,
  last_touched_at INTEGER NOT NULL,
  completed_at    INTEGER
);

-- migration: 0037_runner_api_keys.sql
-- Extend api_keys to support runner-scoped keys
ALTER TABLE api_keys ADD COLUMN runner_id TEXT REFERENCES runners(id) ON DELETE SET NULL;
ALTER TABLE api_keys ADD COLUMN session_id TEXT REFERENCES runner_sessions(id) ON DELETE SET NULL;
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
ALTER TABLE api_keys ADD COLUMN scopes TEXT;  -- JSON: ["runner:connect", "proxy:chat", "mcp:read"]
```

### Runner WebSocket Endpoint

```
GET /api/runners/connect   → WebSocket upgrade
  Query: ?token=cr_abc123  → runner API key
```

**Runner → Chatty (registration):**
```json
{
  "type": "register",
  "runnerId": "c7a3f8e2-...",
  "name": "gaming-pc",
  "labels": ["docker", "linux", "gpu-a6000"],
  "harnesses": ["opencode@2.1.3"],
  "version": "0.1.0"
}
```

**Chatty → Runner (ack):**
```json
{ "type": "registered", "runnerId": "c7a3f8e2-..." }
```

Runner is now idle, waiting for jobs.

### Session Event WebSocket Endpoint

```
GET /api/runners/sessions/:sessionId/events   → WebSocket upgrade
  Query: ?token=cr_abc123                      → runner API key
```

**Runner → Chatty (events):**
```json
{ "type": "status", "status": "cloning" }
{ "type": "status", "status": "container_starting" }
{ "type": "status", "status": "running" }
{ "type": "message", "message": { "role": "assistant", "parts": [...] } }
{ "type": "tool_call", "tool": "read_file", "input": { "path": "src/auth.ts" } }
{ "type": "tool_result", "tool": "read_file", "output": "import..." }
{ "type": "git_diff", "diff": "diff --git a/src/auth.ts\n..." }
{ "type": "pr_created", "url": "https://github.com/user/repo/pull/42" }
{ "type": "form_created", "form": { "id": "...", "title": "...", "fields": [...] } }
{ "type": "form_answered", "formId": "...", "answer": { ... } }
{ "type": "completed", "exitCode": 0 }
{ "type": "error", "message": "Container crashed" }
```

### Runner API Key Generation

**Endpoint:** `POST /api/settings/runners/keys`

Creates a long-lived API key with scopes `["runner:connect"]`. The response includes a **joining URL**:

```json
{
  "key": {
    "id": "key_abc",
    "label": "gaming-pc",
    "token": "cr_...",           // shown once
    "scopes": ["runner:connect"],
    "joiningUrl": "http://localhost:3000/api/runners/join?token=cr_..."
  }
}
```

The user runs `chatty-agent join http://localhost:3000/api/runners/join?token=cr_...` on the runner machine.

### Runner Management UI

**Route:** `/settings/runners`

- List connected runners (name, status badge, labels, harnesses, last heartbeat)
- Generate new runner key / joining URL
- Revoke runner keys
- Delete offline runners

---

## Phase 2 — Chatty: Session Dashboard

### New Routes

| Route | Purpose |
|---|---|
| `/dashboard` | Session dashboard — sidebar + chat/git panels |
| `/dashboard/sessions/[id]` | Single session view |
| `/dashboard/new` | New session dialog |

### Session Dashboard Layout

```
┌──────────┬─────────────────────────┬─────────────────┐
│ Sidebar  │                         │                 │
│          │                         │                 │
│ Sessions │     Chat Panel          │   Git Panel     │
│ List     │     (message stream)    │   (diff,        │
│          │                         │    commit,       │
│ ● active │                         │    push)         │
│ ○ idle   │                         │                 │
│ ✓ done   │                         │                 │
│ ✗ error  │                         │                 │
│          │                         │                 │
│ [+ New]  │                         │                 │
│          ├─────────────────────────┴─────────────────┤
│          │  Chat Input                          [Send]│
└──────────┴───────────────────────────────────────────┘
```

### Sidebar

- Session list grouped by status: Active, Completed, Archived
- Each item: label, harness icon, model, branch, time since last activity
- Status badge: running (green pulse), awaiting_input (yellow), completed (gray), errored (red)
- Click to switch session view
- Right-click context menu: Complete, Archive, Delete
- "New Session" button at top

### Chat Panel

Reuses Chatty's existing `MessageTimeline`, `ToolCallCard`, `Markdown` components from sv-prompt-kit. Messages stream in via SSE from Chatty's server (which receives them from the runner via WebSocket).

No changes to the chat rendering stack — the timeline components are already built. The only difference is messages come from a runner session instead of a `streamText` conversation.

### Git Panel

Shows diff received from the runner. Features:
- Changed files list with syntax-highlighted diff
- Stage/unstage checkboxes (if manual review toggled)
- Commit message input
- "Commit" / "Commit & Push" button
- PR URL badge (appears after push + PR creation)

Git operations are sent as messages back to the runner on the session event WebSocket:

```json
{ "type": "git_action", "action": "commit", "message": "Refactor auth module" }
{ "type": "git_action", "action": "push" }
```

### New Session Dialog

Steps:
1. **Project** — Enter git URL + label, or pick from project registry (future)
2. **Harness** — Dropdown showing harnesses available on connected runners (OpenCode shown as ✓ or ✗ based on runner capabilities)
3. **Model** — Text input or dropdown (model IDs supported by Chatty's proxy)
4. **Branch** — Branch name pattern (default: `chatty/{date}-{label}`)
5. **Base branch** — main, master, or custom
6. **Auto-commit** — Checkbox: "Auto-commit & push on completion" (default off)
7. **Initial prompt** — Text area (optional, can send after start)

On submit: creates `runner_sessions` row (status=queued), sends job to an available runner.

### Message Flow

```
1. User creates session → Chatty DB: runner_sessions (queued)
2. Chatty finds available runner (harness match, online)
3. Chatty → Runner (job dispatch on control WebSocket):
   { type: "job", jobId, sessionId, harness, model, projectUrl, branch, proxyConfig, initialPrompt }
4. Runner accepts → Chatty DB: session status = "starting"
5. Runner opens session event WebSocket
6. Runner streams: status "cloning" → "container_starting" → "running"
7. Runner streams: messages, tool_calls, tool_results
8. Chatty stores each message in DB, pushes SSE to user browser
9. Chatty UI renders messages in chat panel
10. User sends follow-up → Chatty sends { type: "user_message", content } to runner
11. Runner forwards to harness (POST /api/session/{id}/prompt)
12. Agent completes → Runner streams git diff, status "completed"
13. Chatty shows notification, renders diff in git panel
```

---

## Phase 3 — Chatty: Project Registry, Notifications, Cleanup

### Project Registry

```sql
-- migration: 0038_projects.sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  git_url       TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, git_url)
);
```

**UI:** `/settings/projects` — list saved projects with quick "New Session" button.

### Notifications

When a session completes:

1. Chatty stores notification event
2. Browser plays sound via HTML5 Audio API (bundled completion.wav)
3. Browser Notification API: `new Notification("Chatty", { body: "Session 'refactor-auth' completed" })`
4. On macOS: `osascript -e 'display notification "Session completed" with title "Chatty"'` (server-side)
5. Configurable in Settings: notification toggle, sound toggle, sound selection

### Cleanup Scheduler

Cron job in `src/lib/server/jobs.ts`:

```
Every 1 hour:
  1. Query runner_sessions WHERE status IN ('active','awaiting_input')
     AND last_touched_at < now - settings.staleTimeoutDays
  2. Auto-complete them (status = 'completed')
  3. Optionally auto-archive (status = 'archived')
  4. Send cleanup command to runner (clean up workspace dir)
```

Configurable in Settings:
- Stale timeout (days, default 7)
- Auto-archive stale: yes/no
- Auto-delete workspaces: yes/no

---

## Phase 4 — Chatty: Runner Job Dispatch

### `src/lib/server/runners/dispatch.ts`

```typescript
import type { Db } from "$lib/server/db";
import type { Runner, RunnerSession } from "$lib/types";
import crypto from "node:crypto";

interface DispatchJobInput {
  session: RunnerSession;
  projectUrl: string;
  harness: string;
  model: string;
  branch: string;
  baseBranch: string;
  initialPrompt?: string;
  proxyBaseUrl: string;
  mcpGatewayUrl: string;
}

export async function dispatchJob(input: DispatchJobInput): Promise<{ jobId: string }> {
  // 1. Find available runner that supports this harness
  const runner = findRunner(db, { harness: input.harness, status: "online" });
  if (!runner) throw new Error("No available runner for this harness");

  // 2. Create temp API key for this session (proxy + MCP access)
  const { rawKey } = await createApiKey(db, {
    userId: input.session.user_id,
    label: `session:${input.session.id}`,
    scopes: ["proxy:chat", "mcp:read", "mcp:write"],
    sessionId: input.session.id,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });

  // 3. Assign session to runner
  const jobId = crypto.randomUUID();
  await db.run(
    `UPDATE runner_sessions SET runner_id = ?, job_id = ?, status = 'queued' WHERE id = ?`,
    [runner.id, jobId, input.session.id],
  );

  // 4. Dispatch job via runner's control WebSocket
  const ws = getRunnerConnection(runner.id);
  ws.send(JSON.stringify({
    type: "job",
    jobId,
    sessionId: input.session.id,
    harness: input.harness,
    model: input.model,
    projectUrl: input.projectUrl,
    branch: input.branch,
    baseBranch: input.baseBranch,
    initialPrompt: input.initialPrompt,
    proxyConfig: {
      baseUrl: input.proxyBaseUrl,
      apiKey: rawKey,
    },
    mcpGatewayUrl: input.mcpGatewayUrl,
  }));

  return { jobId };
}
```

### Runner Connection Manager

```typescript
// src/lib/server/runners/connections.ts
import { WebSocketServer } from "ws";

const runnerConnections = new Map<string, WebSocket>();  // runnerId → WS

export function getRunnerConnection(runnerId: string): WebSocket | undefined {
  return runnerConnections.get(runnerId);
}

export function registerRunnerConnection(runnerId: string, ws: WebSocket): void {
  runnerConnections.set(runnerId, ws);

  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    switch (msg.type) {
      case "job_accepted":
        await handleJobAccepted(msg);
        break;
      case "job_rejected":
        await handleJobRejected(msg);
        break;
      case "heartbeat":
        await updateHeartbeat(runnerId);
        break;
    }
  });

  ws.on("close", () => {
    runnerConnections.delete(runnerId);
    markRunnerOffline(runnerId);
    // Re-queue any running sessions for this runner
    requeueRunnerSessions(runnerId);
  });
}
```

### Session Event Handler

```typescript
// src/lib/server/runners/events.ts
import type { Db } from "$lib/server/db";
import { publishServerEvent } from "$lib/server/events";
import { upsertMessage, updateSessionStatus } from "$lib/server/sessions/manager";

export async function handleRunnerEvent(
  db: Db,
  sessionId: string,
  event: RunnerEvent,
): Promise<void> {
  switch (event.type) {
    case "status":
      await updateSessionStatus(db, sessionId, event.status);
      publishServerEvent(session.userId, {
        type: "session.status",
        sessionId,
        status: event.status,
      });
      break;

    case "message":
      await upsertMessage(db, sessionId, event.message);
      publishServerEvent(session.userId, {
        type: "session.message",
        sessionId,
        message: event.message,
      });
      break;

    case "tool_call":
      await upsertToolCall(db, sessionId, event);
      break;

    case "tool_result":
      await upsertToolResult(db, sessionId, event);
      break;

    case "git_diff":
      await updateSessionGitDiff(db, sessionId, event.diff);
      publishServerEvent(session.userId, {
        type: "session.git_diff",
        sessionId,
        diff: event.diff,
      });
      break;

    case "pr_created":
      await updateSessionPrUrl(db, sessionId, event.url);
      break;

    case "form_created":
      await updateSessionStatus(db, sessionId, "awaiting_input");
      publishServerEvent(session.userId, {
        type: "session.form_created",
        sessionId,
        form: event.form,
      });
      break;

    case "completed":
      await completeSession(db, sessionId, event.exitCode);
      break;

    case "error":
      await failSession(db, sessionId, event.message);
      break;
  }
}
```

---

## Phase 5 — chatty-agent: Core Daemon

### Project location

The chatty-agent daemon lives in `runner/` at the Chatty repo root (same monorepo, pnpm workspace).

```
runner/
├── package.json
├── tsconfig.json
├── Dockerfile                  # Docker image for the runner itself (optional)
└── src/
    ├── index.ts                # CLI entry point
    ├── cli/
    │   └── commands.ts         # join, start, stop, status, logs, config
    ├── transport/
    │   ├── connection.ts       # WebSocket to Chatty
    │   └── events.ts           # Per-session event streaming WS
    ├── dispatch/
    │   ├── dispatcher.ts       # Job queue + concurrency guard
    │   └── job.ts              # Job → session lifecycle
    ├── harness/
    │   ├── adapter.ts          # HarnessAdapter interface
    │   ├── registry.ts         # HarnessRegistry
    │   └── opencode.ts         # OpenCodeAdapter
    ├── runtime/
    │   └── docker.ts           # DockerRuntime (dockerode)
    ├── git/
    │   └── service.ts          # Clone, branch, diff, push, PR detection
    ├── events/
    │   └── streamer.ts         # Harness events → Chatty WebSocket
    └── health/
        └── monitor.ts          # Container health, stall detection, heartbeat
```

### CLI

```bash
# Join Chatty
chatty-agent join https://chatty.example.com/api/runners/join?token=cr_abc123

# Start daemon
chatty-agent start                 # foreground
chatty-agent start --detach        # background (systemd/launchd)
chatty-agent stop                  # graceful shutdown
chatty-agent status                # connection status, active sessions
chatty-agent logs                  # tail logs

# Config
chatty-agent config show
chatty-agent config edit           # $EDITOR
```

### Config file

```yaml
# ~/.chatty-agent/config.yaml
chatty:
  url: "https://chatty.example.com"
  token: "cr_abc123..."

runner:
  name: "gaming-pc"
  labels: ["docker", "linux", "gpu-a6000"]
  maxConcurrentSessions: 4

docker:
  socketPath: "/var/run/docker.sock"
```

### Transport: Connecting to Chatty

```typescript
// runner/src/transport/connection.ts
import WebSocket from "ws";

export class ChattyConnection {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;  // exponential backoff
  private runnerId: string;

  async connect(url: string, token: string): Promise<void> {
    this.ws = new WebSocket(`${url}?token=${token}`);

    this.ws.on("open", () => {
      this.reconnectDelay = 1000;
      this.register();
    });

    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case "registered":
          this.runnerId = msg.runnerId;
          console.log(`Registered as ${this.runnerId}`);
          break;
        case "job":
          this.dispatcher.enqueue(msg);
          break;
      }
    });

    this.ws.on("close", () => {
      setTimeout(() => this.connect(url, token), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });
  }

  private register(): void {
    this.ws!.send(JSON.stringify({
      type: "register",
      runnerId: config.runnerId,
      name: config.runner.name,
      labels: config.runner.labels,
      harnesses: this.registry.listInstalled(),
      version: "0.1.0",
    }));
  }

  send(msg: object): void {
    this.ws?.send(JSON.stringify(msg));
  }
}
```

---

## Phase 6 — chatty-agent: OpenCode Adapter

### Adapter Interface

```typescript
// runner/src/harness/adapter.ts
export interface HarnessAdapter {
  readonly name: string;
  readonly version: string;

  /** Check if harness image is available (docker pull if needed) */
  ensureImage(): Promise<void>;

  /** Create and start a container for a session */
  startSession(opts: StartSessionOpts): Promise<HarnessSession>;

  /** Send a user message to the running session */
  sendMessage(session: HarnessSession, message: string): Promise<void>;

  /** Get events from the session (SSE stream) */
  streamEvents(session: HarnessSession): AsyncIterable<HarnessEvent>;

  /** Respond to a form */
  answerForm(session: HarnessSession, formId: string, answer: Record<string, unknown>): Promise<void>;

  /** Stop the session (stop + remove container) */
  stopSession(session: HarnessSession): Promise<void>;
}

export interface HarnessSession {
  sessionId: string;
  containerId: string;
  port: number;
  workspacePath: string;
}
```

### OpenCode Adapter

```typescript
// runner/src/harness/opencode.ts
import Docker from "dockerode";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const IMAGE = "ghcr.io/anomalyco/opencode:2.0.0";
const PORT = 4096;

export class OpenCodeAdapter implements HarnessAdapter {
  readonly name = "opencode";
  readonly version = "2.0.0";

  constructor(private docker: Docker) {}

  async ensureImage(): Promise<void> {
    const images = await this.docker.listImages();
    const exists = images.some(img =>
      img.RepoTags?.includes(IMAGE) || img.RepoTags?.includes(`${IMAGE}-latest`)
    );
    if (!exists) {
      console.log(`Pulling ${IMAGE}...`);
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
        });
      });
    }
  }

  async startSession(opts: StartSessionOpts): Promise<HarnessSession> {
    // 1. Write opencode.json into workspace
    const configPath = path.join(opts.workspacePath, "opencode.json");
    await fs.writeFile(configPath, JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      "provider": {
        "chatty": {
          "npm": "@ai-sdk/openai-compatible",
          "options": {
            "baseURL": opts.proxyConfig.baseUrl,
            "apiKey": opts.proxyConfig.apiKey,
          },
          "models": { [opts.model]: {} },
        },
      },
      "mcp": {
        "chatty-memory": { "url": `${opts.mcpGatewayUrl}/memory` },
        "chatty-webfetch": { "url": `${opts.mcpGatewayUrl}/webfetch` },
      },
      "model": `chatty/${opts.model}`,
    }, null, 2));

    // 2. Create container
    const containerName = `chatty-${opts.sessionId.slice(0, 12)}`;
    const container = await this.docker.createContainer({
      Image: IMAGE,
      name: containerName,
      Cmd: ["opencode", "serve", "--port", String(PORT), "--hostname", "0.0.0.0"],
      WorkingDir: "/workspace",
      HostConfig: {
        Binds: [`${opts.workspacePath}:/workspace:rw`],
        PortBindings: { [`${PORT}/tcp`]: [{ HostPort: String(opts.hostPort) }] },
        Memory: opts.memoryLimit || 4 * 1024 * 1024 * 1024,  // 4GB default
        NanoCpus: opts.cpuLimit ? opts.cpuLimit * 1e9 : undefined,
        SecurityOpt: ["no-new-privileges"],
        CapDrop: ["ALL"],
      },
    });

    await container.start();

    // 3. Wait for OpenCode to be ready
    const opencodeUrl = `http://localhost:${opts.hostPort}`;
    await this.waitForReady(opencodeUrl);

    // 4. Create session
    const sessionResp = await fetch(`${opencodeUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory: "/workspace" } }),
    });
    const session = await sessionResp.json();

    // 5. Send initial prompt if provided
    if (opts.initialPrompt) {
      await fetch(`${opencodeUrl}/api/session/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: opts.initialPrompt }),
      });
    }

    return {
      sessionId: session.id,
      containerId: container.id,
      port: opts.hostPort,
      workspacePath: opts.workspacePath,
    };
  }

  async sendMessage(session: HarnessSession, message: string): Promise<void> {
    await fetch(`http://localhost:${session.port}/api/session/${session.sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  }

  async *streamEvents(session: HarnessSession): AsyncIterable<HarnessEvent> {
    const response = await fetch(`http://localhost:${session.port}/api/event`, {
      headers: { Accept: "text/event-stream" },
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            yield this.translateEvent(event);
          } catch { /* skip unparseable lines */ }
        }
      }
    }
  }

  async answerForm(session: HarnessSession, formId: string, answer: Record<string, unknown>): Promise<void> {
    await fetch(`http://localhost:${session.port}/api/session/${session.sessionId}/form/${formId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
  }

  async stopSession(session: HarnessSession): Promise<void> {
    const container = this.docker.getContainer(session.containerId);
    try {
      await container.stop({ t: 10 });  // 10s grace period
      await container.remove();
    } catch { /* container already gone */ }
  }

  private async waitForReady(url: string, timeout = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const resp = await fetch(`${url}/api/info`);
        if (resp.ok) return;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error("OpenCode did not become ready within timeout");
  }

  private translateEvent(raw: unknown): HarnessEvent {
    // Map OpenCode event structure to our HarnessEvent type
    // ...
    return raw as HarnessEvent;
  }
}
```

---

## Phase 7 — chatty-agent: Docker Runtime

### Why Docker API, not Docker specifically

We target the Docker-compatible HTTP API via `dockerode`. This means:

| Runtime | Socket | Notes |
|---|---|---|
| Docker Engine | `/var/run/docker.sock` | Standard, universal |
| OrbStack (macOS) | Same socket | Free for personal use, faster |
| Podman | `podman system service unix:///run/podman/podman.sock` | Free, daemonless |
| colima (macOS) | `~/.colima/default/docker.sock` | Free, Lima VM |

One code path (`dockerode`), all runtimes. No Docker-specific features (no `AutoRemove`, no complex networking).

### Runtime Interface

```typescript
// runner/src/runtime/docker.ts
import Docker from "dockerode";
import { randomBytes } from "node:crypto";

export class DockerRuntime {
  private docker: Docker;
  private workspacesDir: string;

  constructor(socketPath: string, workspacesDir: string) {
    this.docker = new Docker({ socketPath });
    this.workspacesDir = workspacesDir;
  }

  async ensureImage(image: string): Promise<void> {
    // docker pull if not cached
  }

  async createContainer(opts: ContainerOpts): Promise<ContainerInfo> {
    const hostPort = this.findAvailablePort();
    const container = await this.docker.createContainer({
      Image: opts.image,
      name: `chatty-${opts.sessionId.slice(0, 12)}`,
      Cmd: opts.command,
      WorkingDir: "/workspace",
      HostConfig: {
        Binds: [`${opts.workspacePath}:/workspace:rw`],
        PortBindings: { [`${opts.internalPort}/tcp`]: [{ HostPort: String(hostPort) }] },
        Memory: opts.memoryBytes,
      },
    });

    await container.start();
    return { containerId: container.id, hostPort };
  }

  async stopContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop({ t: 10 });
    await container.remove();
  }
}
```

---

## Phase 8 — chatty-agent: Git Service

```typescript
// runner/src/git/service.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitService {
  constructor(private pat?: string) {}

  async clone(url: string, path: string, branch: string): Promise<void> {
    await exec("git", ["clone", "--branch", this.baseBranch(url), "--single-branch", url, path]);
    await exec("git", ["checkout", "-b", branch], { cwd: path });
  }

  async configureAuth(workspacePath: string): Promise<void> {
    if (!this.pat) return;
    // Set git config to use PAT for push
    // git config --local http.https://github.com/.extraheader "Authorization: Bearer $PAT"
  }

  async diff(workspacePath: string): Promise<string> {
    const { stdout } = await exec("git", ["diff", "--stat"], { cwd: workspacePath });
    return stdout;
  }

  async diffFull(workspacePath: string): Promise<string> {
    const { stdout } = await exec("git", ["diff"], { cwd: workspacePath });
    return stdout;
  }

  async commit(workspacePath: string, message: string): Promise<void> {
    await exec("git", ["add", "-A"], { cwd: workspacePath });
    await exec("git", ["commit", "-m", message], { cwd: workspacePath });
  }

  async push(workspacePath: string, branch: string): Promise<string | null> {
    const { stdout } = await exec("git", ["push", "origin", branch], { cwd: workspacePath });
    // Parse push output for PR URL
    return this.extractPrUrl(stdout);
  }

  private baseBranch(url: string): string {
    // Detected or configured base branch
    return "main";
  }

  private extractPrUrl(pushOutput: string): string | null {
    // Parse git push output for PR creation URL
    const match = pushOutput.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    return match?.[0] ?? null;
  }
}
```

---

## Phase 9 — UI: Session Dashboard & Git Panel

### `/dashboard` — Session Dashboard Page

SvelteKit `+page.svelte`:

- Left sidebar: `SessionList` component with status badges
- Main area: `ChatPanel` (reuses existing `MessageTimeline` + `ChatInput`)
- Right panel: `GitPanel` (conditionally shown when session is completed or user expands)
- Top bar: session info (harness icon, model, branch) + action buttons (complete, archive)

### `SessionList.svelte`

```svelte
<!-- Props: sessions (loaded from +page.server.ts) -->
<div class="flex flex-col gap-1 p-2">
  <Button onclick={openNewSession}>+ New Session</Button>
  <Separator />
  {#each activeSessions as session}
    <SessionItem {session} />
  {/each}
  <Separator />
  <Collapsible title="Completed">
    {#each completedSessions as session}
      <SessionItem {session} />
    {/each}
  </Collapsible>
</div>
```

### `ChatPanel.svelte`

Reuses `MessageTimeline` from the existing chat view. Messages come from a Svelte store populated by SSE events from the server.

### `GitPanel.svelte`

```svelte
<script lang="ts">
  let { sessionId }: { sessionId: string } = $props();
  let diff = $state<string | null>(null);
  let prUrl = $state<string | null>(null);

  // Subscribe to git events from the session
  onMount(() => {
    const unsub = subscribeToSessionEvents(sessionId, (event) => {
      if (event.type === "git_diff") diff = event.diff;
      if (event.type === "pr_created") prUrl = event.url;
    });
    return unsub;
  });
</script>

<div class="flex flex-col h-full">
  <h3 class="font-semibold p-2">Changes</h3>
  {#if prUrl}
    <a href={prUrl} target="_blank" class="px-2 text-primary hover:underline">
      View PR #{extractPrNumber(prUrl)}
    </a>
  {/if}
  {#if diff}
    <ScrollArea class="flex-1">
      <pre class="text-sm p-2"><code>{diff}</code></pre>
    </ScrollArea>
  {/if}
  <div class="p-2 border-t">
    <Input placeholder="Commit message" />
    <Button>Commit & Push</Button>
  </div>
</div>
```

### New Session Dialog

Uses `Dialog` (shadcn-svelte):

```
┌─────────────────────────────────────┐
│  New Agent Session                  │
│                                     │
│  Project URL                        │
│  ┌─────────────────────────────────┐│
│  │ https://github.com/user/repo   ││
│  └─────────────────────────────────┘│
│                                     │
│  Label (optional)                   │
│  ┌─────────────────────────────────┐│
│  │ refactor-auth                   ││
│  └─────────────────────────────────┘│
│                                     │
│  Harness          Model             │
│  [OpenCode ▼]     [claude-sonnet  ] │
│                                     │
│  Branch name       Base branch      │
│  [chatty/refactor ] [main      ▼]   │
│                                     │
│  ☐ Auto-commit & push on completion │
│                                     │
│  Initial prompt (optional)          │
│  ┌─────────────────────────────────┐│
│  │ Refactor auth to use JWT       ││
│  └─────────────────────────────────┘│
│                                     │
│  [Cancel]                    [Start]│
└─────────────────────────────────────┘
```

---

## Phase 10 — Cleanup & Recovery

### Chatty-side cleanup (`src/lib/server/jobs.ts`)

```typescript
// Daily job
export async function cleanupSessions(db: Db): Promise<void> {
  const staleTimeout = getSetting(db, "staleTimeoutDays") ?? 7;
  const cutoff = Date.now() - staleTimeout * 24 * 60 * 60 * 1000;

  // 1. Auto-complete stale sessions
  const stale = db.prepare(`
    SELECT id FROM runner_sessions
    WHERE status IN ('active', 'awaiting_input')
      AND last_touched_at < ?
  `).all(cutoff);

  for (const { id } of stale) {
    db.run(`UPDATE runner_sessions SET status = 'completed', completed_at = ? WHERE id = ?`, [Date.now(), id]);
    // Notify runner to clean up workspace
    sendRunnerCommand(runnerId, { type: "cleanup", sessionId: id });
  }

  // 2. Delete temp API keys for completed/failed sessions
  db.run(`
    DELETE FROM api_keys
    WHERE session_id IN (
      SELECT id FROM runner_sessions WHERE status IN ('completed', 'errored', 'archived')
    )
    AND expires_at IS NOT NULL AND expires_at < ?
  `, [Date.now()]);
}
```

### Startup recovery (`hooks.server.ts`)

```typescript
// On Chatty startup
export async function recoverOnStartup(db: Db): Promise<void> {
  // 1. Mark running sessions as errored (runner is gone)
  db.run(`
    UPDATE runner_sessions
    SET status = 'errored', error_message = 'Server restarted — session lost'
    WHERE status IN ('queued', 'starting', 'active', 'awaiting_input')
  `);

  // 2. Delete temp API keys for errored sessions
  db.run(`
    DELETE FROM api_keys
    WHERE session_id IN (
      SELECT id FROM runner_sessions WHERE status = 'errored'
    )
  `);
}
```

### Runner-side recovery

Runner handles its own recovery on startup:
- Checks for orphaned Docker containers → stops + removes them
- Cleans up workspace directories for sessions that no longer exist
- Reconnects to Chatty, re-registers

---

## Implementation Order

| Phase | Scope | Size | Dependencies |
|---|---|---|---|
| 0 | Rip out existing agent system | Small | None |
| 1 | Chatty: runner registry + WebSocket endpoint | Medium | Phase 0 |
| 2 | Chatty: session dashboard + git panel | Large | Phase 1 |
| 3 | Chatty: project registry, notifications, cleanup | Medium | Phase 2 |
| 4 | Chatty: job dispatch logic | Medium | Phase 1 |
| 5 | chatty-agent: core daemon (CLI, transport, dispatch) | Large | Phase 1 |
| 6 | chatty-agent: OpenCode adapter | Large | Phase 5 |
| 7 | chatty-agent: Docker runtime | Medium | Phase 5 |
| 8 | chatty-agent: Git service | Small | Phase 5 |
| 9 | Chatty UI: new session dialog, form rendering | Medium | Phase 2 |
| 10 | Cleanup & recovery (both sides) | Small | All |

Phases 1-4 (Chatty) and 5-8 (chatty-agent) can be developed in parallel.

---

## File Inventory

### New Files in Chatty

```
src/lib/server/runners/
├── connections.ts          # WebSocket connection manager
├── dispatch.ts             # Job dispatch to runners
├── events.ts               # Handle incoming runner events
├── keys.ts                 # Runner API key management
├── registry.ts             # Runner CRUD
├── connections.spec.ts
├── dispatch.spec.ts
├── events.spec.ts
└── registry.spec.ts

src/lib/server/sessions/
├── manager.ts              # Session CRUD, lifecycle
├── cleanup.ts              # Staleness scheduler
├── manager.spec.ts
└── cleanup.spec.ts

src/lib/server/projects/
├── registry.ts             # Project CRUD
└── registry.spec.ts

src/lib/server/notifications/
├── service.ts              # System notifications + sound
└── service.spec.ts

src/lib/server/git/
└── proxy.ts                # Proxy git ops to runner

src/routes/api/runners/
├── connect/+server.ts      # WebSocket upgrade for runner connections
├── sessions/[id]/events/+server.ts  # WebSocket for session events
└── join/[token]/+server.ts          # Joining URL handler

src/routes/(app)/
├── dashboard/
│   ├── +page.svelte        # Session dashboard
│   ├── +page.server.ts
│   └── sessions/[id]/
│       ├── +page.svelte    # Session detail (chat + git)
│       └── +page.server.ts
└── settings/
    ├── runners/
    │   ├── +page.svelte    # Runner management
    │   └── +page.server.ts
    └── projects/
        ├── +page.svelte    # Project registry
        └── +page.server.ts

src/lib/components/app/
├── SessionList.svelte       # Sidebar session list
├── SessionItem.svelte       # Single session row
├── SessionStatusBadge.svelte
├── NewSessionDialog.svelte  # Session creation wizard
├── GitPanel.svelte          # Diff viewer + commit UI
└── FormCard.svelte          # OpenCode form renderer

migrations/
├── 0034_remove_legacy_agents.sql
├── 0035_runners.sql
├── 0036_runner_sessions.sql
├── 0037_runner_api_keys.sql
└── 0038_projects.sql
```

### New Files in chatty-agent (`runner/`)

```
runner/
├── package.json
├── tsconfig.json
├── Dockerfile             # Optional: run the runner itself in Docker
└── src/
    ├── index.ts
    ├── cli/
    │   └── commands.ts
    ├── transport/
    │   ├── connection.ts
    │   ├── events.ts
    │   ├── connection.spec.ts
    │   └── events.spec.ts
    ├── dispatch/
    │   ├── dispatcher.ts
    │   ├── job.ts
    │   ├── dispatcher.spec.ts
    │   └── job.spec.ts
    ├── harness/
    │   ├── adapter.ts
    │   ├── registry.ts
    │   ├── opencode.ts
    │   ├── registry.spec.ts
    │   └── opencode.spec.ts
    ├── runtime/
    │   ├── docker.ts
    │   └── docker.spec.ts
    ├── git/
    │   ├── service.ts
    │   └── service.spec.ts
    ├── events/
    │   ├── streamer.ts
    │   └── streamer.spec.ts
    ├── health/
    │   ├── monitor.ts
    │   └── monitor.spec.ts
    └── config.ts
```

### Removed Files in Chatty

```
src/lib/server/agents/          # Entire directory removed
src/routes/(app)/agents/        # Agent editor UI removed
src/routes/api/agents/          # HTTP trigger removed
```

### Files Modified in Chatty

```
src/lib/types.ts                # + Runner, RunnerSession, Project types
src/lib/server/jobs.ts          # + cleanupSessions, deleteExpiredKeys
src/hooks.server.ts             # + recoverOnStartup, runner startup logic
src/lib/server/events.ts        # Extend for session events
src/routes/(app)/+page.svelte   # Link to dashboard
src/routes/(app)/settings/      # + "Runners" + "Projects" nav items
pnpm-workspace.yaml             # + "runner" package
```