---
name: research-topic
title: Research topic
description: Research a topic with web search and fetches, cross-check sources, and produce a cited summary of findings.
triggers:
  - keyword: 'research'
  - intent: 'research a topic'
  - intent: 'find out about'
when: Use when the user asks to research, investigate, or gather current information about a topic from the web.
tools:
  - web_search
  - fetch
enabled: true
source: bundled
version: '1.0.0'
author: ai-chat
---

Research the topic the user asks about and produce a cited summary.

## 1. Scope

- Restate the research question in one sentence. If it is broad, narrow it to the most useful angle and say what you chose.
- Identify 3–5 sub-questions that together answer it.

## 2. Gather

- Start with 2–3 varied search queries (different phrasings, not synonyms of the same one).
- Fetch only sources that look primary or authoritative: official docs, original papers, vendor pages, primary reporting. Prefer them over aggregators and SEO content.
- For any factual claim that matters, seek a second independent source before including it.
- Read `references/source-quality.md` for how to rank source types if you are unsure.

## 3. Synthesize

- Organize findings by sub-question, not by source.
- Note contradictions between sources explicitly — do not silently average them.
- Distinguish clearly between established facts, reported claims, and your inference.
- Include a short "What I could not verify" section when relevant; never paper over gaps.

## 4. Cite

- Every non-obvious claim gets an inline link to its source.
- End with a source list: title, publisher, and URL for each source actually used.

Do not exceed the user's requested depth. A quick answer with three solid sources beats a long one with ten weak ones.
