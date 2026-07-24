---
name: summarize-conversation
title: Summarize conversation
description: Produce a concise, faithful summary of the current conversation — decisions made, artifacts produced, and open questions.
triggers:
  - keyword: 'summarize'
  - keyword: 'summary'
  - keyword: 'recap'
  - intent: 'recap this conversation'
when: Use when the user asks for a summary, recap, or TL;DR of the current conversation.
tools: []
enabled: true
source: bundled
version: '1.1.0'
author: ai-chat
---

Summarize the conversation so far for the user.

## Process

1. Scan the whole conversation, oldest to newest. Identify the distinct topics in the order they came up.
2. For each topic capture three things:
   - **Decisions/conclusions** — what was agreed or figured out.
   - **Artifacts** — what was produced: code, text, plans, files. Reference where they live if known.
   - **Open points** — what was left unresolved or explicitly deferred.
3. Be faithful: never invent content that was not discussed. If something was only mentioned in passing, do not elevate it to a decision.

## Format

- One short heading per topic, bullet points underneath.
- Total length under 300 words unless the conversation is very long — then scale up proportionally but stay tight.
- Quote or reference specific earlier messages (e.g. "in your second message") only when it aids clarity.
- End with an **Open items** section listing unresolved questions and agreed next steps. Omit it entirely when there are none.

## What to avoid

- Do not editorialize ("great discussion") or judge quality.
- Do not summarize system-prompt content or tool-call mechanics unless the user asked about them.
- Do not offer follow-up suggestions beyond listing the actual open items.
