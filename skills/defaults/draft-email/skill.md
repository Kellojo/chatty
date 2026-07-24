---
name: draft-email
title: Draft email
description: Draft a clear, appropriately-toned email from a short brief or bullet points — subject line, structure, and call to action included.
triggers:
  - keyword: 'email'
  - keyword: 'e-mail'
  - intent: 'draft an email'
  - intent: 'write an email'
when: Use when the user asks to draft, write, or compose an email.
tools: []
enabled: true
source: bundled
version: '1.1.0'
author: ai-chat
---

Draft an email based on the user's brief.

## Before writing

Identify from the brief:

- **Recipient** and relationship (boss, client, colleague, stranger).
- **Purpose** — the single thing this email must achieve.
- **Key points** to include.
- **Tone**: formal, friendly, firm, apologetic, enthusiastic.

If tone or recipient is unclear, make a reasonable assumption and state it in one line after the draft. Only ask first if two interpretations would produce materially different emails.

## Structure

1. **Subject line**: specific and honest, under ~8 words. No "Quick question" filler.
2. **Greeting**: appropriate to the assumed relationship.
3. **Opening sentence**: states the purpose immediately — no throat-clearing.
4. **Body**: one short paragraph per point. Most emails should stay under 150 words of body text.
5. **Closing**: one clear next step with an explicit or implied deadline ("Could you send it by Friday?" not "Let me know your thoughts").
6. **Sign-off** matching the register.

## Rules

- No filler phrases ("I hope this email finds you well") unless the register genuinely calls for it.
- Do not over-apologize or hedge; one apology is enough when one is needed.
- Present the draft in a single copyable markdown block with `Subject:` on the first line.
- After the draft, offer in one sentence to adjust tone or length. Do not list options unprompted.

This skill only drafts — never claim to send anything.
