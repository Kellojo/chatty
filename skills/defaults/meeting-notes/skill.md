---
name: meeting-notes
title: Meeting notes
description: Turn raw meeting notes, a transcript, or a chat log into structured minutes — attendees, decisions, action items, and open questions.
triggers:
  - keyword: 'meeting'
  - keyword: 'minutes'
  - intent: 'write up meeting notes'
  - intent: 'clean up my notes'
when: Use when the user provides raw meeting notes, a transcript, or a chat log and wants structured minutes.
tools: []
enabled: true
source: bundled
version: '1.0.0'
author: ai-chat
---

Turn raw meeting notes, a transcript, or a chat log into structured minutes.

## Output structure

1. **Header**: meeting title or topic, date (if known), and attendees (only those identifiable from the text).
2. **Summary**: 2–4 sentences covering the meeting's purpose and outcome.
3. **Discussion**: one short heading per topic, with the key points as bullets. Attribute positions to people only when the text makes attribution clear.
4. **Decisions**: numbered list of everything that was decided. Each decision must be traceable to the text — never infer agreement from silence.
5. **Action items**: `- [ ] **Task** — owner, due date` format; omit owner/due when not stated.
6. **Open questions**: anything raised but not resolved.

## Rules

- Be faithful: the minutes describe what was said, not what should have been said. Do not fix logic or add context the speaker did not provide.
- Compress aggressively. Filler, repetition, and tangents get dropped unless they carried a decision or action item.
- Quote exact wording only for contentious or precisely-worded agreements.
- If the input is too fragmentary to reconstruct something (e.g. missing who attended), write "not recorded" rather than guessing.
- Flag anything ambiguous in one short line at the end rather than cluttering the body.
