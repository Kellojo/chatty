---
name: plan-and-execute
title: Plan and execute
description: Canonical multi-step workflow — break a task into an explicit plan, execute it step by step with tools, and verify the result before declaring done.
triggers:
  - intent: 'multi-step task'
  - intent: 'plan and execute'
  - intent: 'complex request'
when: Use for any non-trivial task that requires multiple tool calls or ordered steps, especially in agent mode.
tools: []
enabled: true
source: bundled
version: '1.1.0'
author: ai-chat
---

Use this workflow for any non-trivial multi-step task.

## 1. Plan

- Restate the goal in one sentence to confirm understanding.
- Break it into 3–8 concrete steps, each independently verifiable.
- Note which tool each step needs. If a needed tool is not available, say so immediately instead of silently working around it.
- Identify the riskiest step and what you will do if it fails.

## 2. Execute

- Work through the steps in order; state which step you are on.
- After each tool call, briefly check the result against what you expected. On unexpected output, stop and reassess — never push forward on a wrong assumption.
- If a step fails after the available retries, try exactly one alternative approach, then report the blocker clearly with what you tried.
- Keep intermediate outputs you will need later; do not re-derive them.

## 3. Verify

- Before finishing, re-read the original goal and check it against what was actually produced — not against the plan.
- Run every cheap verification available: re-read written files, re-run searches, check counts, run a build or test if one exists.
- If verification fails, fix it and re-verify, or report the gap explicitly. **Never mark the task complete with failed verification.**

## 4. Report

Summarize in a few lines: what was done, what was skipped or failed (and why), and where the outputs live (files, conversations, IDs).
