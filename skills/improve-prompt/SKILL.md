---
name: improve-prompt
description: Improve an existing Can I Vibecode It? entry whose build prompt is generated, vague, outdated, or not genuinely runnable. Use for promptCurated false entries or prompt-focused contribution requests.
---

# Improve a catalogue prompt

## Goal

Replace a weak prompt with a concise, opinionated, genuinely runnable one without changing the editorial verdict unless new evidence requires it.

## Workflow

1. Read the complete app entry and current contribution rules.
2. Reassess the core loop, requirements, and what the product's moat prevents.
3. Select one implementation stack appropriate to the product.
4. Write a 15-30 line prompt that specifies:
   - product goal and primary user;
   - exact included workflows;
   - deliberate exclusions;
   - data model and persistence;
   - external APIs and `.env` secrets;
   - required tests and README;
   - local run and build commands;
   - accessibility, privacy, and platform constraints where relevant.
5. Remove menus, optional stack choices, aspirational filler, and claims that cannot be implemented in one session or weekend under the verdict.
6. Set `promptCurated: true` only after a human-quality rewrite.
7. Do not set `verifiedOneShot: true` without running verify-one-shot.
8. Run repository validation and build.
9. Raise a draft PR scoped to one app unless the user explicitly requests a coordinated cleanup.

## Review test

A reviewer should be able to paste the prompt into Codex, Claude Code, or Cursor in an empty folder without answering architectural questions before useful implementation begins.
