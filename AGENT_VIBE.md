# Vibecode It — Agent Task Log

This file records work completed by coding agents in this repository. Add one entry for every task, including validation and the resulting commit when applicable.

## Working rules

- Work on the `monster` branch unless Faizan explicitly requests otherwise.
- Keep each completed feature in a focused commit with a clear message.
- Push completed commits to `origin/monster`.
- Preserve Faizan Ali as the live operator and retain attribution to Rob Hallam and Can I Vibecode It?.
- Record tests, builds, or other verification performed for each task.

## Product direction: production starter kit

### Problem

Can I Vibecode It? can provide a verdict and a build prompt, such as "yes, one session, no moat," but it does not provide the production engineering required to turn a demo into software people can trust. The missing layer includes authentication, payments, transactional email, caching, security, and observability.

### Proposed solution

Build a production-grade backend and frontend starter kit with the essential infrastructure pre-wired, documented, and ready to customize:

- Authentication: sessions or JWT, OAuth, and password reset.
- Payments: Stripe one-time payments and subscriptions, with correct webhook handling.
- Email: transactional email behind a provider abstraction so providers can be replaced without rewriting the application.
- Cache: optional, pluggable Redis support.
- UI: customizable dashboard and landing-page templates.
- Observability: structured logging and an error-tracking integration hook.
- Security: rate limiting and hardened middleware on authentication endpoints by default.

### One codebase, two usage modes

#### Quick mode

For solo and indie developers. It uses zero-configuration defaults with one auth method, one payment provider, and one email provider. The intended workflow is `clone → env → run`, producing a working demo in under ten minutes without requiring architectural decisions.

#### Extend mode

For builders who need a longer-lived production foundation. It uses the same scaffold and includes an `ARCHITECTURE.md` that explains each default, why it was selected, how it behaves as the product scales, and how to replace modules without fighting the framework.

### Setup and modularity

- Intended setup command: `npx create-yourkit` (working placeholder; final package name is not decided).
- Interactive prompts include or exclude modules such as payments and cache.
- Quick and Extend modes must remain configurations of the same tool and codebase, not separately maintained products.

### Documentation philosophy

Every module ships with a short Markdown guide explaining what it does, why its default was chosen, and how to extend or replace it. Quickstart documentation stays short and immediately actionable; architecture documentation is optional and explains the deeper reasoning when needed.

### Open decision

The v1 backend stack is not yet selected. The current candidates are Node/Express and Go. Do not choose or implement either stack without a later product decision.

## Phased build prompts

Every app's `prompt` is being rewritten from a one-shot paragraph into a phased,
module-by-module build guide, ten apps per batch. The format spec lives in
`CONTRIBUTING.md` under "The phased format". Facts that drift (API pricing, model
names, library APIs, CLI flags) are verified against primary sources before they
go into a prompt, and the check date belongs in the entry.

Progress: **20 of 1,093 converted.**

### Batch 1 — flagship YES verdicts (2026-09-04)

| App | Category | Phases | Researched fact that changed the prompt |
| --- | --- | --- | --- |
| `carrd` | website-builder | 6 | — |
| `cronitor` | cron | 5 | Healthchecks ping scheme: `/start`, `/fail`, `/<exit code>`, `/log`; 100 kB body cap; returns `OK` |
| `getwaitlist` | waitlists | 6 | — |
| `granola` | meeting-notes | 6 | ScreenCaptureKit needs no virtual audio driver; audio-only needs a screen output with a large `minimumFrameInterval` (or Core Audio process taps on 14.2+); `whisper-cli` accepts 16-bit WAV only |
| `linktree` | link-in-bio | 5 | — |
| `plausible` | analytics | 7 | Visitor hash is `hash(daily_salt + domain + ip + user_agent)`, and the salt is deleted on rotation |
| `qr` | qr-codes | 7 | `qr-code-styling` v1.5.x API: `download({name, extension})`, `imageOptions`, corner options |
| `shots` | screenshots | 6 | Safari requires a `Promise<Blob>` in `ClipboardItem`; Chromium accepts it, so one code path serves both |
| `testimonial-to` | testimonials | 6 | — |
| `typefully` | social-media | 6 | X killed the free API tier: new developers get pay-per-use at ~$0.015/post and ~$0.20/post with a link. The old prompt's "free tier is read-only" was wrong |

### Batch 2 — remaining priority-5 YES verdicts (2026-09-04)

| App | Category | Phases | Researched fact that changed the prompt |
| --- | --- | --- | --- |
| `uptime` | uptime | 6 | — |
| `wispr-flow` | voice-dictation | 6 | Input Monitoring and Accessibility are separate grants; the permission prompt appears once per launch, so a dismissal needs a relaunch; pasteboard + Cmd-V beats per-character `CGEvent` (key codes, not characters); password fields refuse synthetic input by design |
| `tally` | forms | 8 | — |
| `ghost-pro` | publishing | 8 | Ghost production requires MySQL 8.0/8.4 (MariaDB and SQLite unsupported); transactional email is SMTP but newsletters go through Mailgun's API, still the only first-class bulk provider self-hosted. The old prompt conflated the two |
| `ynab` | personal-finance | 8 | SimpleFIN Bridge is ~$15/year and is what Actual Budget uses, so bank sync is affordable rather than impossible · the old prompt ruled it out entirely |
| `invoice-ninja` | finance-accounting | 8 | — |
| `todoist` | tasks | 7 | — |
| `feedly` | rss-research | 7 | — |
| `obsidian-sync` | notes-knowledge | 6 | — |
| `bitwarden` | security | 7 | vaultwarden's `ADMIN_TOKEN` must be an Argon2 PHC hash from `/vaultwarden hash`; `$` needs `$$` escaping in a Compose env file; you log in at `/admin` with the original password, not the hash |

Deliberately deferred from this batch, with reasons: `showtrust` (same domain as
the already-converted `testimonial-to`, and its existing prompt is the most
detailed in the repo, so the marginal gain is smallest), `umami-cloud` (a
near-duplicate of `plausible`), and `superwhisper` (a near-duplicate of
`wispr-flow`). Converting ten variations of two prompts in one batch would have
produced worse prompts than picking ten domains.

### Batches still to run

The remaining 1,073 entries keep their one-shot prompts until converted. 21
`pagePriority: 5` `yes` verdicts are left, including the three deferred above.
After those: `kinda` verdicts (where the phase that states the unclosable gap
matters most), then the long tail. `no` verdicts render no prompt at all and need
no conversion.

Watch for clusters of near-identical apps (three task managers, two dictation
tools, several macOS utilities). Convert one well, then adapt · but do not put
two of a cluster in the same batch.

## Task log

### 2026-09-04 — Create and publish the feature branch

- Confirmed the GitHub remote is `https://github.com/faizanalibaig/vibecodeit.git`.
- Created the `monster` branch from `main` while preserving the existing working tree.
- Published `monster` and configured it to track `origin/monster`.
- No application files were changed for this task.

### 2026-09-04 — Audit, validate, and publish the existing rebrand

- Reviewed the pending working tree and confirmed it contains the Vibecode It rebrand, operator/legal identity updates, homepage category UX, accent-color updates, and the repository-wide product/domain rename described in `AGENT_HANDOFF.md`.
- Added this task log and established the ongoing branch, commit, push, and verification rules above.
- Fixed an unmatched paragraph tag in `src/pages/thebuildgames/terms.astro` discovered by the production build.
- Regenerated 1,095 branded OG images through the standard build pipeline.
- Verification: `npm run validate` passed for 1,093 app files; `npm test` passed; `npm exec -- astro build` passed after the markup correction.
- Runtime check: development server started at `http://127.0.0.1:8095/` and returned HTTP 200 for the homepage.
- Commit: `feat: rebrand product as Vibecode It` (pushed to `origin/monster`).

### 2026-09-04 — Preserve the production starter-kit concept

- Added the product problem, proposed solution, module scope, Quick and Extend modes, setup model, and documentation philosophy to this persistent context file.
- Recorded `npx create-yourkit` as a placeholder rather than a finalized package name.
- Kept the Node/Express versus Go v1 stack choice explicitly unresolved.
- Documentation-only task; no application behavior changed and no runtime verification was required.
- Commit: `docs: capture production starter kit direction` (pushed to `origin/monster`).

### 2026-09-04 — Add multi-file project packs to verdict pages

- Replaced the single visible prompt on application detail pages with a structured project-pack workspace.
- Added an accessible build-depth toggle above the pack:
  - Indie dev: four lean files (`README.md`, `AGENTS.md`, `BUILD_PLAN.md`, and `.env.example`) optimized for a small personal or weekend build.
  - Product builder: five production-oriented files (`PRODUCT.md`, `ARCHITECTURE.md`, `AGENTS.md`, `MILESTONES.md`, and `OPERATIONS.md`) covering product scope, boundaries, delivery, security, quality, and operations.
- Generated each file from the selected application's existing build brief, requirements, limitations, core workflow, and alternatives instead of adding duplicate per-app data.
- Added file navigation, per-file copy, responsive mobile layout, selected-mode summaries, and analytics for mode selection.
- Updated the existing copy, Claude Code, Codex, and Cursor actions to send the complete selected multi-file bundle while preserving the existing integrations.
- Verification: `git diff --check`, `npm run validate` (1,093 app files), `npm test`, and `npm exec -- astro build` all passed.
- Visual QA: confirmed the 1Password page in the local browser, switched between both modes, navigated project files, and verified complete-pack copying.
- Commit: `feat: add multi-file project packs` (pushed to `origin/monster`).

### 2026-09-04 — Replace account-backed stacks with local storage

- Removed the sign-in/account control and signup modal from the global navigation experience.
- Replaced the navigation action with `my stack`, including a device-local saved-item count and compact mobile bookmark control.
- Moved verdict-page and death-list saves from the authenticated `/api/stack` flow to the `vibecodeit:stack` browser local-storage key.
- Added `/stack`, a noindex device-local stack page with saved projects, monthly subscription totals, possible yearly savings, removal controls, and popular empty-state suggestions.
- Removed server-side stack lookups from verdict pages so saves no longer require a session or account.
- Removed the sign-in auto-credit prompt from app submissions and updated privacy and terms copy to accurately describe local-only stack storage.
- Left dormant backend authentication and account code intact so authentication can be restored later without destructive migration work.
- Verification: `node --check public/js/app.js`, `git diff --check`, `npm run validate` (1,093 app files), `npm test`, and `npm exec -- astro build` passed.
- Browser QA: saved 1Password locally, confirmed the nav count and both save controls updated, navigated to `/stack`, verified persistence and totals, removed the item, saved an empty-state suggestion, and confirmed the empty state returned after cleanup.
- Commit: `feat: move my stack to local storage` (pushed to `origin/monster`).

### 2026-09-04 — Rewrite batch 1 prompts as phased build guides

- Replaced the one-shot `prompt` on ten flagship apps with phased build guides of
  87 to 122 lines each: a fixed stack, a data model defined before Phase 1, five to
  seven dependency-ordered phases each carrying `Build:`, a falsifiable `Done when:`
  check and a `Do not build yet:` boundary, then `Out of scope (and why)` and
  `README must contain`.
- Apps converted: `carrd`, `cronitor`, `getwaitlist`, `granola`, `linktree`,
  `plausible`, `qr`, `shots`, `testimonial-to`, `typefully`.
- Verified drifting external facts against primary sources rather than memory, and
  corrected one outright error: the `typefully` prompt claimed X's free API tier is
  read-only, when as of 2026 there is no free tier for new developers at all
  (pay-per-use, ~$0.015 per post, ~$0.20 per post containing a link). See the batch
  table above for the rest.
- Used `###` headings inside prompts so they nest correctly under the `## Original
  build brief` and `## Starting brief` headings of the generated project pack;
  confirmed the rendered bundles carry a clean `#` / `##` / `###` hierarchy.
- Kept the house rule of `·` over em dashes: zero em dashes across all ten.
- Updated `CONTRIBUTING.md`: dropped the "15–30 lines" cap, which the phased format
  contradicts, and documented the format, the phase-ordering rules, and the
  requirement to verify external facts before writing them into a prompt.
- Added the conversion tracker above and the batch list to `CLAUDE.md`.
- Verification: `git diff --check`, `npm run validate` (1,093 app files),
  `npm test` (13 passing), and `npm exec -- astro build` all passed. Confirmed the
  patch touched only the `prompt` field on each of the ten entries.
- Runtime check: served the production build on port 8099 (a dev server predating
  this task held 8095 and was deliberately left running) and confirmed all ten
  pages return HTTP 200 with the phased prompt present in both the indie and
  product bundles and in the visible per-file panes.
- Commit: `feat: rewrite batch 1 prompts as phased build guides` (pushed to `origin/monster`).

### 2026-09-04 — Rewrite batch 2 prompts as phased build guides

- Converted ten more entries to the phased format, 97 to 130 lines each:
  `uptime`, `wispr-flow`, `tally`, `ghost-pro`, `ynab`, `invoice-ninja`,
  `todoist`, `feedly`, `obsidian-sync`, `bitwarden`.
- Eight of the ten were `promptCurated: false` generated prompts and are now
  hand-written, so the flag was flipped to true alongside the rewrite.
- Four of the ten are operations rather than build tasks (`ghost-pro`,
  `bitwarden`, `obsidian-sync`, and partly `invoice-ninja`). Their phases are
  deploy-and-verify stages, and each keeps its rule-zero line: do not write a CMS,
  do not write a password manager, do not write a sync engine. Both `ghost-pro`
  and `bitwarden` end on a restore drill that must actually be performed, with the
  date recorded in the README.
- Research corrected two prompts that were materially wrong or incomplete: the
  `ghost-pro` prompt conflated transactional SMTP with newsletter delivery, which
  self-hosted Ghost routes through Mailgun's API specifically; and the `ynab`
  prompt ruled out bank sync entirely when SimpleFIN Bridge does it for about
  $15/year. See the batch 2 table for the rest.
- Selection deliberately skipped three near-duplicates of batch 1 rather than
  filling the batch by rank; the reasoning is recorded above the batch table.
- Verification: `git diff --check`, `npm run validate` (1,093 app files),
  `npm test` (13 passing), and `npm exec -- astro build` all passed. Confirmed the
  patch touched only `prompt` and `promptCurated` on each entry.
- Runtime check: served the production build on port 8099 and confirmed all ten
  pages return HTTP 200 with the phased prompt present and a clean `#`/`##`/`###`
  hierarchy in the generated pack files. The pre-existing dev server on 8095 was
  left running untouched.
- Commit: `feat: rewrite batch 2 prompts as phased build guides` (pushed to
  `origin/monster`).

### 2026-09-04 — Add a device-local build tracker to verdict pages

- Moved the big verdict badge (`KINDA · weekend project`) out of its stacked slot
  and onto one row to the left of the save-to-my-stack control, by switching
  `.verdict-side` from a column to a wrapping row.
- Added a build tracker in the position the badge used to dominate, directly under
  the header stats: a percentage, a progress bar, and one checkable row per module
  with an expandable panel carrying that module's `Build` lead paragraph and its
  full `Done when` acceptance check.
- Modules come from the prompt itself. Phased prompts are parsed for their
  `### Phase N · Title` sections, so the tracker lists this app's real build
  sequence; the 1,073 entries not yet converted fall back to the generic delivery
  order. That order is now defined once as `DELIVERY_ORDER` in `[slug].astro` and
  rendered into both `BUILD_PLAN.md` and the fallback tracker, instead of existing
  as two copies that could drift.
- Progress is stored device-local in `localStorage` under `vibecodeit:progress`,
  matching the my-stack contract: no account, no server round trip. Each entry
  records the module count it was saved against, so a prompt that later gains or
  loses phases invalidates its own stale ticks rather than crossing off the wrong
  modules. Reset arms before clearing, like the stack's remove control.
- No inline scripts were added: the page still carries exactly the two hashed
  inline scripts declared in `src/lib/csp.js`.
- Verification: `node --check public/js/app.js`, `git diff --check`,
  `npm run validate` (1,093 app files), `npm test` (13 passing), and
  `npm exec -- astro build` all passed. Confirmed the refactored `DELIVERY_ORDER`
  renders `BUILD_PLAN.md` byte-identically to before.
- Runtime check on the production build at port 8099: the tracker renders 6 real
  modules for the phased `granola` and the 5-step fallback for the not-yet-phased
  `1password`, every selector the script queries resolves in the served HTML, and
  the badge precedes the save control in the header markup.
- Not verified: no headless browser is installed in this environment, so the
  visual result was checked structurally rather than rendered and looked at. Worth
  a human glance on a phone width before this is considered done.
- Follow-up: matched the big verdict badge to the save-to-my-stack control beside
  it · pill radius `999px`, `font-size: 13px`, `padding: 8px 14px`, and a
  transparent 1px border so both pills come out the same outer height. The
  verdict colors stay in `.badge.yes` / `.badge.kinda` / `.badge.no`, untouched,
  and the weight stays bold because it is a verdict rather than a control.
- Commit: `feat: track build progress per module on verdict pages` and
  `style: round the verdict badge to match the save control` (pushed to
  `origin/monster`).

### 2026-09-04 — Move build tracking to its own step-by-step page

- Corrected the previous task: the tracker had been built inline on the verdict
  page, when what was asked for was a button in the slot the big verdict badge
  used to occupy, leading to a dedicated page.
- Removed the inline tracker card from `src/pages/[slug].astro`.
- Added a `track this build` call to action in the header, in the badge's old
  slot. The verdict badge and the save-to-my-stack control now pair on a
  `.verdict-row` beneath it, keeping the badge to the left of save as requested.
  The CTA reads back saved progress on load, so a return visit says how many
  steps are left rather than inviting a restart.
- Added `src/pages/[slug]/build.astro`, following the existing `[slug]/` sub-page
  convention: a sticky progress header, a `Before step 1` block carrying the
  prompt's stack decision, data model and the app's requirements, then one card
  per step on a numbered rail with the full `Build` text (bullets and code spans
  preserved), the `Done when` check as a callout, the `Do not build yet`
  boundary, a mark-done control and a link to the next step. Steps already ticked
  collapse on arrival so the page opens on the one being worked. `noindex`: the
  steps are the prompt's own words and an indexable copy would compete with the
  verdict page for the same terms.
- Extracted the parsing into `src/lib/build-plan.js` so both pages share one
  definition: `parsePhases`, `promptSection`, `buildSteps`, and `DELIVERY_ORDER`,
  which still renders `BUILD_PLAN.md`'s delivery order and doubles as the
  fallback for the 1,073 prompts not yet phased.
- Progress stays device-local in `localStorage` under `vibecodeit:progress`,
  stamped with the step count so a changed prompt invalidates its own stale ticks.
- Verification: `node --check public/js/app.js`, `git diff --check`,
  `npm run validate` (1,093 app files), `npm test` (13 passing), and
  `npm exec -- astro build` all passed.
- Runtime check on the production build: `/granola/build` renders 6 real modules
  with the stack and data model surfaced, `/bitwarden/build` renders its rule-zero
  block, `/1password/build` renders the 5-step fallback with the honest note, the
  verdict page carries the CTA and no inline tracker, every selector the script
  queries resolves, the page still carries only the two hashed inline scripts, and
  the new route stays out of the sitemap.
- Not verified: no headless browser here, so the visual result was checked
  structurally rather than rendered and looked at.
- Follow-up on layout: the header row is now the project title on the left and
  `track this build` on the right, aligned to the title's centre line; the verdict
  badge and save-to-my-stack moved to their own left-aligned row directly beneath
  the title. `.verdict-side` was removed entirely rather than left as dead CSS.
- Commit: `feat: add a step-by-step build page per app` and
  `style: title and track CTA on one row, verdict and save beneath` (pushed to
  `origin/monster`).

Note for anyone reviewing locally: `src/lib/apps.js` caches the app dataset at
first read, so a dev server started before a `data/apps/*.json` edit keeps serving
the old prompts · a phased app will show the 5-step fallback until the server is
restarted.

### 2026-09-04 — Drop the question mark from the alternatives-page link label

- `src/pages/[slug]/alternatives.astro`: the link back to the verdict page now
  reads `can I vibecode it` instead of `can I vibecode it?`.
- Left every other occurrence alone deliberately. The strings in
  `src/layouts/Base.astro`, `src/pages/terms.astro` and `src/pages/privacy.astro`
  are `Can I Vibecode It?` as the name of Rob Hallam's upstream product, not a
  question · the question mark is part of that product's name, and the handoff
  rules require the attribution to stay exactly as it is.
- Verification: `git diff --check`, `npm run validate` (1,093 app files),
  `npm test` (13 passing), and `npm exec -- astro build` passed. Runtime check
  confirmed the label renders without the question mark and the footer
  attribution on the same page is unchanged.
- Commit: `copy: drop the question mark from the alternatives link label`.
