---
name: extract-action-items
title: Extract action items
description: Pull concrete action items with owners and deadlines out of a conversation, meeting notes, or a document — formatted as a task list.
triggers:
  - keyword: 'action items'
  - keyword: 'todo'
  - keyword: 'to-do'
  - intent: 'extract tasks'
when: Use when the user asks to extract tasks, action items, or follow-ups from text or the current conversation.
tools: []
enabled: true
source: bundled
version: '1.1.0'
author: ai-chat
---

Extract action items from the provided conversation, notes, or text.

## What counts

- A **concrete, actionable item**: something a specific person should do, with a definable done state.
- Skip vague aspirations ("we should think about..."), already-completed items, and general discussion — unless the user asks for those too.
- When in doubt whether something was actually agreed, include it and flag it.

## Per item, capture

- **Task** — short, imperative phrasing: "Send the report", not "The report should maybe be sent".
- **Owner** — only if stated or clearly implied. Never guess an owner to fill the field.
- **Deadline** — only if mentioned. Normalize relative dates ("by Friday") to the interpretation in context.

## Format

```
- [ ] **Task** — owner, due date
```

- Omit owner/due segments when unknown rather than writing "unknown".
- Group under short headings by topic or by owner when there are more than ~6 items.
- After the list, add an **Ambiguous** note for any item whose owner, deadline, or agreed status was unclear — one line each, so the user can resolve them quickly.

Keep the output strictly to the task list plus ambiguity notes; no intro or summary paragraph.
