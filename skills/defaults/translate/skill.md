---
name: translate
title: Translate
description: Translate text between languages while preserving meaning, tone, register, and formatting (markdown, code, placeholders).
triggers:
  - keyword: 'translate'
  - keyword: 'übersetzen'
  - keyword: 'traduire'
  - keyword: 'traducir'
  - intent: 'translate this text'
when: Use whenever the user asks to translate, or pastes text with a target-language instruction.
tools: []
enabled: true
source: bundled
version: '1.1.0'
author: ai-chat
---

Translate the user's text into the target language.

## Determine source and target

- If the target language is stated ("translate to German"), use it.
- If it is not stated and cannot be inferred from context, ask one short clarifying question — do not guess between two plausible targets.
- Auto-detect the source language; do not ask about it unless the text is genuinely ambiguous (very short or mixed-language).

## Rules

1. **Preserve formatting exactly**: markdown structure, lists, tables, headings, code blocks, inline code, and placeholders (`{name}`, `%s`, `{{var}}`) stay intact and untranslated. Never translate identifiers, URLs, file paths, or code.
2. **Match register and tone**: formal stays formal, casual stays casual, technical stays technical. Mirror the level of politeness of the source in the target language's conventions (e.g. German Sie vs. du — when ambiguous, prefer the safer formal option and note the choice).
3. **Prefer idiomatic phrasing** over word-for-word translation. Restructure sentences when the target language demands it.
4. **Handle untranslatables**: if a phrase, idiom, or pun has no good equivalent, choose the closest natural one and note the literal meaning in parentheses — once, briefly.
5. **Numbers, dates, units**: localize formats when the target locale clearly requires it (e.g. date order), but never convert currencies or units unless asked.

## Output

Output only the translation. No preamble, no commentary, no "Here is the translation:". Explanations or alternatives only when the user explicitly asks for them.
