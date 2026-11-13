---
name: automate-task
title: Automate a task
description: Set up an agent that does something on its own, on a schedule ("every Monday at 9", "daily", "remind me…") or when something happens (a new chat, a memory change, a finished coding thread). Also for changing or checking such automations.
tools:
  - create_agent
  - update_agent
  - list_agents
  - start_agent
  - now
enabled: true
source: bundled
version: '1.0.0'
author: ai-chat
---

Turn the user's request into an agent that runs without them, then prove it works.

## 1. Check what exists

Call `list_agents` first. If an agent already does this (or nearly), offer to change it with `update_agent` instead of creating a duplicate.

## 2. Pick the trigger

| The user says | `triggerType` | `triggerConfig` |
|---|---|---|
| "every day / Monday / hour at …" | `schedule` | `cron` |
| "whenever / each time X happens" | `event` | `event`, optionally `every` |
| "I'll run it myself", "on demand" | `manual` | – |
| "I want to chat with it" | `persona` | – (it becomes selectable in chat instead of running on its own) |

Events: `chat.created`, `chat.message_completed`, `memory.changed`, `skill.created`, `skill.updated`, `skill.deleted`, `coding.thread.finished`. `every: N` runs only on every Nth occurrence. Use it for noisy events such as `chat.message_completed`. If what the user wants to react to isn't in this list, say so and suggest a schedule that checks for it instead.

## 3. Write the cron (schedule only)

- Cron runs in the **server's time zone**, not necessarily the user's. Call `now` (no arguments) to see it. If the user named another zone, convert the time and tell them what you did.
- Five fields: `minute hour day-of-month month day-of-week`. Examples: `0 9 * * 1` = Mondays 09:00, `30 7 * * 1-5` = weekdays 07:30, `0 */2 * * *` = every 2 hours, `0 18 1 * *` = 18:00 on the 1st of each month.
- Do not schedule more often than the task needs. Every run costs a full model turn.
- "Remind me once at …" is not a schedule: there is no one-off trigger. Say so, and offer a recurring one or a manual agent.

## 4. Write the agent

- **`name`**: short and specific ("Monday standup prep"), not "Assistant".
- **`systemPrompt`**: the agent's standing role. It runs with **no access to this chat**, so it must be fully self-contained. Include every fact it needs (names, URLs, file paths, preferences the user gave), the output format, and what "done" looks like.
- **`triggerConfig.instructions`**: what to do on each run, e.g. "Summarize yesterday's chats and list open questions". The run starts from this message.
- **`canAsk`**: leave the default (`any`) so each run shows up as a chat the user can read and reply to. Use `approvals` when it should only stop before risky actions such as deleting or sending. Use `never` only for silent housekeeping: those runs are hidden from the chat list.
- Leave `providerId`/`modelId`, `toolAllowlist` and `maxSteps` unset unless the user asks. Set `skillNames` when an existing skill fits the task (e.g. `research-topic`).

## 5. Test it

Unless it is a persona, run it once: `start_agent` with `wait: true`. Check the `result`:

- It did the job → tell the user it works.
- It failed or did the wrong thing → fix the prompt with `update_agent` and run it again. Two attempts at most, then report what is going wrong.

Skip the test only when a run would do something the user would not want right now (e.g. send a message). In that case, say that it is untested.

## 6. Confirm

Show the result as a ```agent card (see `create_agent`), then one or two lines: when it runs next, in the user's terms ("Mondays at 9:00 Berlin time"), where its output appears, and that it can be paused or edited on the Agents page.
