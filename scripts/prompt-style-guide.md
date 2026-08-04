# One-shot build prompt · style guide

How to write the `prompt` field in `data/apps/*.json`. A one-shot build prompt is what a
reader pastes into Claude Code, Codex CLI, or Cursor in an empty folder to get a working
personal replacement for a paid product in one session. This guide exists to rewrite the
template-generated prompts, which read like filled-in forms, not like a builder telling an
agent what to make.

`npm run validate` prints the current count under `prompt-shape`. It checks the shape
below rather than the `promptCurated` flag, because the flag is self-reported and wrong in
both directions: entries carrying hand-written prompts still say `false`, and a few say
`true` over generator output.

Reference exemplars (match their voice and density):
- `data/apps/granola.json`
- `data/apps/calendly.json`

## Why prompts fail (what the research says, condensed)

- Vague prompts force the agent to guess users, features, storage, and scope. Guesses
  become rework. Specific beats clever every time.
- Unstated stack means the agent picks one, often a heavyweight framework. Name the stack
  and the agent stops deliberating and starts building.
- No acceptance criteria means "looks done" is the only stop signal. Concrete outputs
  ("save to ~/MeetingNotes/YYYY-MM-DD-HHMM.md") give the agent something checkable.
- No stated non-goals invites gold-plating: auth systems, user tables, deploy configs,
  abstraction layers nobody asked for. Say what NOT to build.
- Criteria must be binary. "A 5-bullet summary, decisions made, and action items with
  owners" is checkable. "Good AI notes" is not.

## Required shape (mechanical)

Every prompt has exactly this structure:

1. **Opening line**: `Build me a <specific thing> like <PaidProduct>.` or
   `Build me a <specific thing> to replace <PaidProduct>.` One sentence. Name the paid
   product being replaced. Add the platform if it matters ("for macOS"). Then the literal
   word `Requirements:` on the same line or the next.
2. **6-10 bullets**, each starting with `- `. Each bullet is one decision or one feature
   with its concrete behavior. Order: core loop first, then storage, then interface
   details, then constraints, then out-of-scope, then README.
3. **Length: 15-30 lines total** (as rendered with wrapped bullets in the JSON string,
   roughly 120-220 words). Under 15 lines you are underspecifying; over 30 you are
   writing a PRD, cut it.

Format inside the JSON string: `\n\n` after the opening line, `\n` between bullets,
wrap long bullets with `\n  ` continuation indent like the exemplars do.

## Rules (apply all of them)

1. **One opinionated stack per app.** Name real libraries and tools, not categories.
   Good: whisper.cpp, better-sqlite3, satori, sharp, Express, htmx, yt-dlp, ffmpeg,
   Playwright, SwiftBar, chokidar, node-cron, SQLite FTS5, Ollama, resend/SMTP.
   Bad: "a web app framework", "a database", "an AI API". If two stacks are genuinely
   fine, offer at most one either/or with a decision rule ("Swift or an Electron tray
   app, pick the simpler to ship"). Never list three options.
2. **State the storage choice** in its own bullet or clause: SQLite (say the driver if
   Node: better-sqlite3), flat Markdown files, JSON files, or a plain folder convention
   with a concrete path (`~/MeetingNotes/`). Personal scale means no Postgres, no ORM,
   no Docker unless the app genuinely needs it.
3. **Secrets via .env.** Any API key, OAuth credential, or SMTP login is "in .env" or
   "key from .env". Never hardcoded, never a settings UI.
4. **The privacy line appears once**, adapted to the app: "No accounts, no telemetry,
   local-first where possible." Variants: "everything stays on my machine except the API
   calls", "binds to localhost only". Do not pad it into multiple bullets.
5. **Name the interface.** Every prompt says what the human touches: a CLI command, a
   local web page on a port, a menu bar/tray app, a folder that fills up, a daily email.
   If it is a web page, one line on what it shows. Never leave the interface implied.
6. **1-2 explicit out-of-scope items** so the agent does not gold-plate. Pull them from
   the app's `whatYouLose` and pick the ones an agent would otherwise attempt: "Out of
   scope: multi-user accounts and mobile apps" or "Skip: real-time collaboration, sync".
   Phrase as an instruction to the agent, not as an apology to the reader.
7. **End with a README bullet where relevant**: setup steps, required keys, OS
   permissions to grant (mic, screen recording, accessibility), OAuth console steps.
   Skip it only when there is genuinely nothing to set up.
8. **Concrete acceptance details over adjectives.** File paths with date formats, field
   lists ("name + email + note"), specific numbers ("next 14 days", "30-min slots,
   15-min buffer"), exact outputs ("a 5-bullet summary, decisions made, and action items
   with owners"). Every bullet should be verifiable by looking at the built app.
9. **Honest warnings where the exemplars have them.** If one step is known pain (Google
   OAuth consoles, macOS screen-audio permission), say so inside the prompt: "budget an
   hour for the Google Cloud console alone". This is the site's voice, keep it.
10. **Respect the verdict.** For `"verdict": "kinda"` apps, scope the prompt down to the
    honest personal core (a solo booking page, not team Calendly). Never prompt for the
    parts the page itself says you cannot rebuild. For `"yes"` apps, cover the full core
    loop from `coreLoopDIY`.

## Voice

- Direct, technical, first person where natural ("my calendar", "my timezone", "warn me
  in the README"). You are a competent person telling an agent what to build for
  yourself.
- No marketing language. Banned: seamless, powerful, beautiful, delightful, robust,
  blazing, intuitive, "production-ready". If a word could appear on a landing page,
  cut it.
- No em dashes. Use commas, a period, or `·` instead.
- No headings, numbering, or nested bullets inside the prompt. Flat `- ` bullets only.
- Never paste the template phrases from the old generator: "Core loop:", "Needs: X.",
  "Honest scope: this covers the core loop only. You will not get:". Their presence
  means the prompt was not rewritten.

## Worked example: notion.json, before → after

**Before** (`"promptCurated": false`, template output · every failure mode at once:
"Needs:" bullets name categories not tools, no interface, no concrete behaviors, the
scope note is an apology instead of an instruction):

```
Build me a personal replacement for Notion (Flexible docs, databases, wikis, and
lightweight project workspace). Requirements:

- Core loop: Build a block-based notes app with markdown-ish editor, simple databases,
  backlinks, templates, and local/cloud sync.
- Needs: web app framework.
- Needs: database.
- Needs: auth.
- Needs: rich-text/block editor.
- Needs: optional LLM API.
- Needs: hosting.
- Keep it personal-scale: no accounts, no telemetry, secrets in .env, SQLite or
  flat files for storage. Local-first wherever possible.
- Clean minimal UI where one is needed; CLI is fine where one is not.
- Include a README with setup steps, required keys, and any OS permissions.

Honest scope: this covers the core loop only. You will not get: mature block editor;
cross-device sync; permissions.
```

**After** (scoped to the honest solo core per the app's "kinda" verdict, one stack,
concrete behaviors, real out-of-scope instruction):

```
Build me a personal notes-and-databases app to replace Notion. Requirements:

- A local web app: Node + Express + better-sqlite3, server-rendered pages with a
  little vanilla JS. No frontend framework, no build step.
- Pages are Markdown, stored in SQLite, edited in a plain textarea with a live
  preview pane (render with marked). Markdown is the format, not blocks.
- [[Wiki-style]] links between pages, with a backlinks section rendered at the
  bottom of every page.
- Simple databases: a page can define a table (columns typed text/number/date/select),
  rows editable inline, stored as JSON in SQLite.
- Full-text search across everything via SQLite FTS5, search box in the header.
- A nightly export of all pages to a folder of plain .md files, so my notes are
  never trapped in the app.
- Binds to localhost only. No accounts, no telemetry, everything on my machine.
- Out of scope: real-time collaboration, cross-device sync, and a block editor.
  Do not build auth or hosting config, this runs on my own machine.
- Include a README with setup steps and where the data lives on disk.
```

What changed, mechanically: six "Needs:" category bullets became four feature bullets
with named libraries and checkable behaviors; auth and hosting moved from requirements
to out-of-scope (the verdict says a solo tool, so they were wrong to require); the
interface is now stated (local web app, localhost); the apology paragraph became an
instruction to the agent; the export bullet adds a concrete escape hatch a real builder
would want.

## Quality checklist (verify every rewritten prompt)

1. Opens `Build me a … like/to replace <PaidProduct>.` then `Requirements:`; 6-10 flat
   bullets; 15-30 lines total.
2. Exactly one stack, with at least two real library/tool names; storage named
   concretely (driver or path).
3. Interface stated: CLI, local web page, menu bar/tray, folder, or email.
4. Secrets in .env (if any keys are needed) and the no-accounts/no-telemetry/local-first
   line appears once.
5. 1-2 out-of-scope items phrased as instructions, consistent with the app's verdict
   and `whatYouLose`.
6. Every bullet is verifiable (paths, formats, counts, field lists), no marketing
   adjectives, no em dashes, no leftover "Core loop:" / "Needs:" / "Honest scope:"
   template strings.
7. README/permissions bullet present when setup, keys, or OS permissions exist; known
   pain points get an honest one-line warning.

After rewriting, set `"promptCurated": true` in the app's JSON.
