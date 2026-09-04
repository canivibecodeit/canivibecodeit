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

### 2026-09-04 — Drop the question mark from the homepage heading

- `src/pages/index.astro`: the hero `h1` now reads `Can I vibecode it` (with
  `Can I` struck through and `it` in the accent color, as before) instead of
  `Can I vibecode it?`. The mark was plain text outside both spans, so no styling
  changed.
- Left the product branding and the attribution alone: the `<title>`,
  `og:site_name` and JSON-LD still carry `Vibecode It?` as the product name, and
  the footer credit still reads `Can I Vibecode It?` for Rob Hallam's upstream
  product. Say so explicitly if the brand itself should lose its question mark ·
  that is a rename touching titles, structured data and OG metadata sitewide,
  not a copy tweak.
- Verification: `git diff --check`, `npm run validate` (1,093 app files),
  `npm test` (13 passing), and `npm exec -- astro build` passed. Runtime check
  confirmed the rendered `h1`, and that the title, `og:site_name` and footer
  attribution are unchanged.
- Commit: `copy: drop the question mark from the homepage heading`.

### 2026-09-04 — Restore the homepage question mark, struck through

- `src/pages/index.astro`: the hero `h1` reads `Can I vibecode it?` again, with the
  question mark wrapped in the existing `.struck` span so the line-through runs
  across it exactly as it does across `Can I`. The heading now reads as the
  question being crossed out, which is the joke the strikethrough was making all
  along · struck `Can I`, accent `it`, struck `?`.
- No CSS was added: `.hero h1 .struck` already carries the line-through, its
  thickness and color. The mark sits flush against `it` with no space.
- Left the sub-heading alone: `One question each: vibecode it today, or keep
  paying?` is a real question and reads correctly with its mark.
- Verification: `git diff --check`, `npm run validate` (1,093 app files),
  `npm test` (13 passing), and `npm exec -- astro build` passed. Runtime check
  confirmed the rendered markup and that no space crept in before the mark.
- Commit: `copy: restore the homepage question mark, struck through`.

### 2026-09-04 — Repitch the newsletter: a weekly sunday guide, open to submissions

- Changed the newsletter promise from "five vibe-coding tips, thursdays" to "a new
  guide to technology, every sunday · submit yours and we'll publish it", and
  rewrote every heading, description and supporting line to match.
- Updated all thirteen places the old promise appeared, because a newsletter that
  says thursday in one placement and sunday in another is broken:
  `src/components/DigestCard.astro` (heading, sub, button, fine print),
  `src/components/DigestBar.astro`, `src/components/DigestReveal.astro` (default
  sub), `src/pages/newsletter.astro` (meta description, `h1`, sub, submit button,
  fine print, the "in every issue" list, and the file's own comment),
  `src/pages/submit.astro`, the `newsletterCard` OG template in
  `scripts/generate-og.mjs`, and the three "see you thursday" toasts in
  `public/js/app.js`. A grep for `thursday` across `src/`, `scripts/` and
  `public/js/` now returns nothing.
- The OG card's cache key is manual, so it was bumped from `newsletter:1` to
  `newsletter:2`; without that the hashed cache would have kept serving the old
  image. `npm run og` re-rendered exactly one file, `public/og/newsletter.png`.
- Gave the submission claim a real path rather than leaving it as a promise with
  no route: the newsletter page now points at
  `hello@vibecodeit.com` (the documented operator contact) with a prefilled
  subject, and says the guide runs with the writer's byline. No new backend ·
  there is no article submission pipeline, and inventing a half one would be
  worse than an email address.
- Note on cadence: no send day is hardcoded anywhere. `scripts/weekly-digest.mjs`
  sends whenever it is invoked, so whatever cron or manual routine triggers it has
  to move to Sunday for the copy to stay true.
- Verification: `node --check public/js/app.js`, `git diff --check`,
  `npm run validate` (1,093 app files), `npm test` (13 passing),
  `npm exec -- astro build`, and `npm run og` all passed. Runtime check confirmed
  the new copy on the homepage digest card, the digest bar, and `/newsletter`
  including the mailto link.
- Commit: `copy: repitch the newsletter as a weekly sunday guide`.

### 2026-09-04 — Article submissions: nav entry, /write, and a review queue

- Built the submission system the new newsletter copy promises, so "send yours in
  and we'll publish it" points at a real route instead of an email address.
- `src/pages/write.astro`: the public form · title, byline, email, optional link
  and summary, and the draft itself. Renders its limits from `LIMITS` in
  `src/lib/articles.js`, the same constants the API validates against, so the
  character counter can never disagree with what the server accepts. A `noscript`
  fallback keeps the mailto path for anyone without JavaScript.
- `src/lib/articles.js`: validation shared by both callers · length bounds, email
  shape, a public-URL check that refuses IP literals and `.local`/`.internal`
  hosts (the same shape check the app submitter uses), and control-character
  stripping that keeps newlines in the body but collapses them in single-line
  fields.
- `src/pages/api/article.js`: POST validates, rate limits (3 per IP per day, 100
  a day globally), stores the draft as `pending`, and emails Faizan through
  `alertAdmin`. Synchronous, unlike `/api/submit` · there is no AI draft or PR to
  open, so the writer gets a real answer in one request instead of polling.
  Honeypot answers exactly like a success so a bot learns nothing from the
  difference.
- `src/pages/admin/articles.astro` and `src/pages/api/article/admin.js`: the
  token-gated review queue with accept, reject with a note, and back-to-queue,
  following the existing build-queue pattern including the same-origin guard on
  `return_to`.
- `src/lib/db.js`: an `articles` table in both the SQLite and Postgres schemas
  with matching driver methods and exported wrappers.
- Nav: added `write a guide` to the single `SECTIONS` list in
  `src/layouts/Base.astro`, which drives both the header and the footer, and
  pointed the newsletter page and the digest card's copy at `/write`.
- Deliberately NOT built: a public blog. Nothing in the `articles` table is ever
  rendered on the site · accepted means the guide goes into a sunday issue with
  the writer's byline. Rendering submissions publicly is a separate feature with
  its own moderation, SEO and abuse questions, and half-building it would have
  put unreviewed reader HTML on the domain.
- Verification: `node --check` on `app.js`, `db.js` and `articles.js`,
  `git diff --check`, `npm run validate` (1,093 app files), `npm test` (13
  passing), and `npm exec -- astro build` all passed. The validator was
  unit-tested directly for each rejection path.
- Runtime check against the built server with a throwaway `DATA_DIR`: `/write`
  and `/newsletter` 200; `/admin/articles` 404s without a token, 404s with a wrong
  one and 200s with the right one; every validation rejection returns its message
  at 400; the honeypot returns a success shape and stores nothing; a cross-origin
  POST is refused 403 once `SITE_URL` is set (the guard is a no-op when it is
  unset, which is existing sitewide behavior); the per-IP rate limit returns 429
  on the fourth draft; accept and reject redirect back with a message; and a
  `//evil.example` `return_to` falls back to `/` rather than redirecting off-site.
- Commit: `feat: accept reader-submitted guides`.

### 2026-09-04 — Whole-project audit: security, performance, bugs

- Audited the project end to end rather than the pending diff, in risk order:
  dependencies, injection sinks, the request trust boundary, every API endpoint's
  guards, the Stripe webhooks, the hot rendering paths, and the code added today.
- Findings, security: `npm audit` reports 0 vulnerabilities. Every `set:html`
  goes through `scriptJson` or the two CSP-hashed snippets; every client-side
  `innerHTML` in `globe.js` and `dither.js` escapes its data. All dynamic SQL in
  `db.js` interpolates only column names drawn from whitelists
  (`SUBMISSION_FIELDS`, `BUILD_FIELDS`, `PURCHASE_LOOKUP_COLS`); values are
  parameterised throughout. Both Stripe webhooks verify the signature with a
  timing-safe compare and a replay tolerance. Icon uploads are streamed with a
  byte cap and sniffed, and rate-limited per IP and per token inside the shared
  `iconEndpoint`. The two public POSTs that looked unguarded at the file level
  (`rec/impression.js`, `thebuildgames/icon.js`) rate-limit inside their shared
  helpers. Every cookie-authenticated state change (`account/delete`, `stack`,
  `build`, `build/media`, `article`) checks `crossOrigin`; the endpoints that do
  not are token-gated admin routes, signature-verified webhooks, or idempotent
  rate-limited beacons. No code change was warranted.
- Configuration note, not a code bug: with `ORIGIN_VERIFY_SECRET` unset,
  `clientIp` trusts the first `x-forwarded-for` entry, so per-IP rate limits can
  be spoofed; and `crossOrigin` is a no-op until `SITE_URL` or `BETTER_AUTH_URL`
  is set. Both are the documented rollout ladders in `.env.example` and
  `src/middleware.js`, and both should be set in production.
- Findings, performance: on the production build, `/` renders in ~30 ms
  (1.15 MB of HTML · the full death list, by design, compressed by the reverse
  proxy), verdict pages in 2–4 ms, `/alternatives` in 7 ms, `/api/search` in
  3 ms. PostHog-backed pages are cached with stale-while-revalidate in
  `src/lib/analytics.js`. `voteCounts()` is one query per render over at most
  1,093 rows. Nothing needed changing.
- Bug fixed: `allApps()` in `src/lib/apps.js` cached the dataset for the life of
  the process in every mode, so an edit to `data/apps/*.json` did not appear in
  the dev server until a restart · the exact confusion hit earlier today when a
  phased prompt showed the 5-step fallback. The cache now stays on in production
  (confirmed in the compiled bundle: `"DEV": false`, so `CACHE` is true) and is
  bypassed under `import.meta.env.DEV`. Optional chaining keeps plain Node
  (scripts, tests) on the cached path, verified by importing the module directly.
- Tests added, pinning today's two new libraries: `test/build-plan.test.mjs`
  (7 tests, including the multi-line `Done when` regression the parser had
  earlier today) and `test/articles.test.mjs` (10 tests covering every rejection
  path, both cleaning modes, CRLF normalisation, caps, `parseLink`, and a guard
  that the source carries no raw control bytes). `npm test` is now 30 passing.
- Verification: `node --check src/lib/apps.js`, `git diff --check`,
  `npm run validate` (1,093 app files), `npm test` (30 passing), and
  `npm exec -- astro build` passed.
- Commit: `fix: re-read app data per request in dev; add parser and validator
  tests` (pushed to `origin/monster`).

### 2026-09-04 — Add 30 researched apps to the death list

- Asked for up to 50 valuable new entries; delivered 30 after checking 238
  candidate products against the existing 1,093 by domain and by name (the
  domain check alone missed UptimeRobot under `betterstack.com`, Excalidraw+
  and Harvest). Dropped free or open-source-only tools, dead products,
  near-duplicates, saturated categories, and anything whose price could not be
  verified (Pastebin, Hotjar behind a demo funnel, TinyPNG's paid web plan).
- Weighted toward the thin categories: `cron` grows from 1 to 3
  (`healthchecks-io`, `dead-mans-snitch`), `og-images` from 0 to 2
  (`bannerbear`, `placid`), `publishing` from 1 to 4 (`hashnode`, `bear-blog`,
  `medium`), `link-in-bio` gains `beacons`, `screenshots` gains `urlbox` and
  `snappify`, `uptime` gains `hyperping`. The rest: `formspree`, `dub`,
  `postman`, `insomnia`, `ngrok`, `webhook-site`, `resend`, `algolia`,
  `pinecone`, `remove-bg`, `gitbook`, `cookiebot`, `cloudinary`, `tailscale`,
  `doppler`, `onesignal`, `wetransfer`, `pocket`, `headway`.
- Verdicts: 17 yes, 11 kinda, 2 no (`medium`, `resend`). `pocket` carries
  `discontinued: "shut down on July 8, 2025"` and renders as a post-mortem.
  Operations-shaped entries (`algolia`, `pinecone`, `cloudinary`, `tailscale`,
  `doppler`) keep a rule-zero line: deploy Meilisearch, use pgvector, run
  imgproxy, run headscale, use sops.
- Pricing: every `pricing` block is dated 2026-09-04 with its source URL. 22 are
  `confidence: high` from the vendor's live pricing page; 8 are `medium` where
  the vendor blocks fetches or renders prices client-side (`formspree`,
  `bear-blog`, `beacons`, `remove-bg`, `placid`, `wetransfer`, `pocket`
  historical, and `cookiebot` noted in EUR). Research corrected assumptions:
  Dub has no free plan and starts at $90; WeTransfer retired Pro in late 2024;
  Tailscale is free for six users, so its honest DIY case is owning the control
  plane, not saving money.
- Every prompt is in the phased format (4 to 6 phases, 35 to 55 lines), passes
  the parser, and carries no em dash. Generated from Python with the entries as
  data so the JSON is byte-identical to `JSON.stringify(a, null, 2)` and the
  key order matches existing files. `alternatives` and `rejectedAlternatives`
  are empty: the curated-alternatives bar requires per-tool verification this
  task did not do, and an empty list renders honestly.
- Ran `scripts/fetch-icons.mjs` for the 30 icons. It also re-fetched two
  pre-existing icons and produced junk (`jobscan.png` at 0 bytes, `eraser.png`
  at 307); reverted those and their regenerated OG cards. `public/og/home.png`
  changed legitimately because the headline MRR total moved.
- Updated the app count in `CLAUDE.md` from 1,093 to 1,123.
- Verification: `npm run validate` (1,123 app files), `npm test` (30 passing),
  `npm exec -- astro build`, `node scripts/generate-og.mjs` (30 new cards),
  `git diff --check`. Runtime on the built server: all 30 verdict pages and
  their `/build` pages return 200, the Pocket banner renders, the homepage counts
  1,123 apps, `/category/cron` lists all three, `/category/og-images` renders.
- Commit: `feat: add 30 researched apps across thin categories` (pushed to
  `origin/monster`).

### 2026-09-04 — Add a back-to-top button

- Added a floating back-to-top control to `src/layouts/Base.astro`, so it is on
  every page: a real `<button>` with `aria-label="Back to top"`, hidden until
  `app.js` arms it, appearing once the page has scrolled past 600px.
- Placed it after `<DigestBar />` in the DOM deliberately. The digest bar slides
  into the same corner and is nearly full width below 940px, so a general-sibling
  rule (`.digest-bar.show ~ .to-top`) stands the button down while the bar is up
  rather than letting them overlap. Higher specificity than `.to-top.show`, so
  the bar wins without any JavaScript coordination between them.
- Cleared the other things that live on the bottom edge: below 1280px the sponsor
  tape owns the last 46px, so the button sits at `bottom: 62px` (the same reason
  `.digest-bar` sits at 52px there); above 1280px the right sponsor rail runs the
  full height at `right: 16px`, so the button offsets by `calc(var(--sp-side) + 8px)`,
  reusing the variable the layout already defines for the rail's width plus gutter.
  Both offsets are scoped to `body:not(.no-tape)` so sponsor-free pages keep the
  corner.
- Behavior in `public/js/app.js` follows the existing patterns: a passive scroll
  listener that only sets a flag with the class flip in a `requestAnimationFrame`,
  and an `AbortController` registered through `onLeave` so soft navigation unhooks
  it, matching the digest bar. `sync()` runs once on init because a reload can
  restore a scrolled position before any scroll event fires.
- Accessibility: `visibility: hidden` rather than opacity alone, so the button is
  out of the tab order and the accessibility tree while hidden; the click moves
  focus to the header brand link, without which a keyboard visitor scrolls up but
  resumes tabbing from where they were; and `prefers-reduced-motion` drops both
  the slide-in and the smooth scroll.
- No inline scripts added · the page still carries only the two hashed inline
  scripts from `src/lib/csp.js`.
- Verification: `node --check public/js/app.js`, `git diff --check`,
  `npm run validate` (1,123 app files), `npm test` (30 passing), and
  `npm exec -- astro build` passed. Runtime on the built server: the button
  renders on `/`, `/granola`, `/granola/build`, `/stack`, `/newsletter` and
  `/write`, sits after `.digest-bar` in the DOM, and the compiled CSS carries
  `.to-top`, `.to-top.show`, the sibling rule and both media offsets.
- Not verified: no headless browser here, so the scroll threshold, the fade and
  the focus move were reviewed statically rather than exercised in a browser.
- Follow-up, same day: the two positional offsets were wrong in practice. The
  rail offset (`right: calc(var(--sp-side) + 8px)`) put the button well inside
  the content column, floating over page text · worse than the overlap it was
  avoiding. Both media-query offsets removed; the button is now pinned to the
  corner at `right: 16px; bottom: 16px` on every viewport and wins on stacking
  order instead (z-index 70, above the sponsor tape at 60 and the rails at 40).
  The `.digest-bar.show ~ .to-top` rule stays: it hides rather than moves, and
  it is the one case where two controls genuinely occupy the same corner.
- Commit: `feat: add a back-to-top button` and `style: pin the back-to-top
  button to the corner` (pushed to `origin/monster`).

### 2026-09-04 — Reprice the sponsor slots to a $199 ladder

- Repriced the board to start at $199 and rise $50 a slot in the order it
  renders: L1 $199, L2 $249, L3 $299, L4 $349, L5 $399, R1 $449, R2 $499,
  R3 $549, R4 $599, R5 $649. Previously $299 to $1,499.
- `SLOT_SEED` in `src/lib/db.js` was reordered to match the board's display
  order (it had been interleaved L1, R1, L2, R2 by price rank) and given a
  comment explaining that its INSERTs are `ON CONFLICT DO NOTHING`, so it prices
  a slot exactly once, when the row is first created.
- That is the important part: **editing the seed does not reprice a board that
  already exists**, so the live site keeps its old prices until someone acts.
  Added `scripts/set-slot-prices.mjs`, which applies the ladder to whichever
  database it is pointed at. Dry run by default, `--apply` writes, and slots
  with an active purchase against them are skipped unless `--force` · a sponsor
  who has paid keeps the rate they bought, which is what the sponsor page
  promises. `SLOT_SEED` is now exported so the script and the seed cannot drift.
- Verified end to end against a throwaway SQLite board: seeded fresh it comes up
  on the new ladder; set back to the old prices, the dry run listed all ten
  changes and wrote nothing, `--apply` wrote all ten, and `/sponsor` then
  rendered $199 through $649 in order.
- NOT changed, and it now contradicts the board: the sponsor page still says
  "$2,500 flat · your rate never rises while you stay" in two places
  (`src/pages/sponsor/index.astro`, the September block and the slots heading).
  That figure already did not match the old $299-$1,499 ladder either. Picking a
  new headline number is a pricing decision, so it is flagged rather than
  invented.
- Verification: `node --check` on `db.js` and the new script, `git diff --check`,
  `npm run validate` (1,123 app files), `npm test` (30 passing), and
  `npm exec -- astro build` passed.
- Commit: `feat: reprice sponsor slots to a $199 ladder` (pushed to
  `origin/monster`).

### 2026-09-04 — Build kits: beginner-friendly per-project plans for all 50 phased apps

- Asked for proper per-project development files for indie dev and product
  builder, and a tracker that is beginner friendly rather than top level, naming
  what is needed before the project starts (API keys, accounts, tools). Built the
  system, then authored a kit for every app with a phased prompt: all 50.
- New data source `data/builds/<slug>.json`, one per app, validated by
  `scripts/validate-builds.mjs` inside `npm run validate`. The format is documented
  in `CONTRIBUTING.md` under "Build kits": summary, time, stack with reasons,
  prerequisites (kind, why, exactly how to get it, verify, cost, optional, url),
  env vars (example, required, secret, where the value comes from), phases with
  sub-steps (do, detail, commands, files, snippet), tickable checks and traps,
  `productOnly` phases, and product extras (outcome, architecture modules with a
  swap path, operations, release gate). The validator rejects a phase with fewer
  than two steps or no check, duplicate ids, non-UPPER_SNAKE env names, missing
  cost or how-to-get on a prerequisite, and em dashes.
- `src/lib/build-kit.js` owns loading (cached in prod, re-read in dev), validation,
  mode filtering, and both pack generators. The generic templates moved out of
  `[slug].astro` into `genericPack` unchanged, so every app without a kit renders
  exactly what it did; `kitPack` renders real per-project files: indie
  `README.md` (stack table, prerequisite checklist with get/verify/cost, quick
  start lifted from the first commands, honest limits), `BRIEF.md` (the prompt,
  shipped because it carries the data model and the exact acceptance wording),
  `AGENTS.md` (project-specific rules plus the kit's traps), `BUILD_PLAN.md`
  (every phase with numbered steps, fenced commands, tickable checks, watch-outs)
  and `.env.example` generated from the env table; the product set adds
  `PRODUCT.md`, `ARCHITECTURE.md` (modules table), `MILESTONES.md` (all phases
  including production-only) and `OPERATIONS.md` (backup, restore, monitoring,
  incident, release gate). 7 tests in `test/build-kit.test.mjs`.
- `/<slug>/build` with a kit is now the beginner path: an indie / product toggle
  (remembered per device, hides `productOnly` phases and their items from the
  total), the summary and stack chips, a "Before step 1" list where each
  prerequisite is tickable and shows why, how to get it, verify and cost, with API
  keys tagged, the prompt's data model, an environment-variable table, then each
  phase on the numbered rail with tickable sub-steps, copyable command blocks,
  files, snippets, a tickable "done when" list and a watch-out callout. Progress
  ids are strings and the saved entry is keyed by `kit-<version>`; the verdict
  page CTA reads the saved percentage back. Apps without a kit render the previous
  prompt-phase view unchanged.
- The 50 kits: the 20 batch-1 and batch-2 apps and the 30 added today. Each names
  its real prerequisites: Anthropic or OpenAI keys with the console path and
  pay-per-use cost, X developer pay-per-use pricing, SimpleFIN's $15 a year,
  Mailgun for Ghost newsletters with the DNS records, vaultwarden's Argon2 admin
  token and the `$$` Compose trap, MaxMind GeoLite2 licence keys, Stripe test-mode
  keys and Payment Links, S3-compatible bucket credentials with CORS, VAPID keys,
  ntfy topics, whisper.cpp model downloads with sizes, Xcode, Docker, age, sops,
  headscale, Playwright's Chromium download, and the free alternative to check
  first where one exists (Bruno, cloudflared). Every kit carries a `productOnly`
  operate-or-distribute phase: monitoring, structured logs, off-box backups with a
  restore drill, firewall and updates, or notarization and Sparkle for the Mac
  apps. Authored as Python data and written as JSON so the files are byte-stable.
- Verification: `npm run validate` (1,123 app files, 50 build kits), `npm test`
  (37 passing), `npm exec -- astro build`, `git diff --check`. Runtime on the
  built server: all 50 verdict pages and all 50 `/build` pages return 200 with the
  kit rendering, the fallback page for an app without a kit is unchanged, the
  pack on a kit page lists the per-project files with BRIEF.md second, and pages
  still carry only the two hashed inline scripts.
- Not verified: no headless browser here, so the tracker's toggles, mode switch,
  copy buttons and progress persistence were reviewed statically against the
  served markup rather than clicked.
- Commit: `feat: build kits with beginner-friendly plans for all 50 phased apps`
  (pushed to `origin/monster`).

### 2026-09-04 — Make repository scripts portable on Windows and start locally

- Fixed six repository scripts that derived the project root from the raw
  `import.meta.url` pathname, which produced paths such as `D:\\D:\\Development`
  on Windows. They now use Node's `fileURLToPath` conversion consistently.
- Covered the validation, build, icon-fetching, OG-generation, and seed-import
  scripts so the same platform bug does not recur in adjacent workflows.
- Installed dependencies with the bundled Node.js runtime and explicitly allowed
  the declared native build steps for `better-sqlite3` and `esbuild`.
- Verification: 1,123 app files and 50 build kits pass validation; all 37 tests
  pass; all 1,125 OG images generated; the Astro production server build passed.
- Runtime check: the built server started at `http://127.0.0.1:8095/`; `/`,
  `/granola`, and `/granola/build` each returned HTTP 200.
- Commit: `fix: make repository scripts portable on Windows`.
