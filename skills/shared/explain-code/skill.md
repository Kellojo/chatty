---
name: explain-code
title: Explain code
description: Explain a piece of code clearly — what it does, how it works, why it is written that way — adapted to the reader's experience level.
triggers:
  - keyword: 'explain'
  - intent: 'explain code'
  - intent: 'what does this code do'
when: Use when the user pastes code and asks what it does, how it works, or for a walkthrough.
tools: []
enabled: true
source: bundled
version: '1.1.0'
author: ai-chat
---

Explain the code the user provides.

## Structure

1. **One-sentence summary** first: what the code does overall, in plain terms.
2. **Walkthrough** in logical order (not necessarily top to bottom): entry point and inputs → core logic → outputs and side effects. For anything longer than ~15 lines, use short headings or a numbered structure.
3. **The why, not just the what**: call out idioms, design choices, non-obvious behavior, and anything that would surprise a reader. This is usually the most valuable part.

## Depth calibration

- If the user seems experienced (uses precise terminology, asks pointed questions), skip basics and focus on the interesting parts: control flow subtleties, invariants, performance characteristics.
- Otherwise, briefly define jargon as you go. One short parenthetical is enough — do not turn the explanation into a tutorial unless asked.

## Issues and edge cases

Point out potential bugs, edge cases, or performance concerns **only when they are real and relevant** to this code as written. Do not pad with generic advice ("consider adding error handling") that applies to any code.

## Presentation

- Reference specific lines with small inline excerpts (a few tokens), not giant re-quotes.
- If the code depends on context you cannot see (types, called functions, framework behavior), state your assumption in one line rather than hedging throughout.
