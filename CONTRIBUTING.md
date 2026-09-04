# Contributing an app

Every app on the death list is one JSON file in `data/apps/<slug>.json`, added by PR.
The repo is the admin panel. Don't feel like writing JSON? The
[submit form](https://vibecodeit.com/submit) drafts the entry and opens the
PR for you — this document is the spec either way, and PRs are always welcome
directly.

## Schema

```jsonc
{
  "slug": "granola",             // filename must match; lowercase, hyphens
  "name": "Granola",             // display name ("Senja / Testimonial.to" for a pair)
  "domain": "granola.ai",        // primary domain, used to fetch the favicon
  "category": "meeting-notes",   // one of the keys in src/lib/apps.js CATEGORIES
  "subcategory": "meeting transcription + AI notes",  // optional, freeform
  "tagline": "AI meeting notepad ...",                // one line, what the app is
  "priceMonthly": 14,            // typical paid tier, USD/month; null if it varies
  "discontinued": null,          // optional: if the product is dead, a fragment that
                                 // reads as "{name} {discontinued}." e.g. "shut down on
                                 // September 24, 2025". The page keeps the verdict but
                                 // shows a post-mortem banner and past-tense pricing.
  "pricing": {                   // provenance — prices drift, receipts matter
    "plan": "Business", "basis": "monthly per user",
    "unit": "per-seat",          // flat | per-seat | usage | one-time | custom
    "source": "https://www.granola.ai/pricing", "checkedOn": "2026-07-30",
    "confidence": "high", "notes": null, "native": "14 USD",
    "freeTier": "The free Basic plan includes AI notes but only limited meeting history.",
    // freeTier is optional: one plain sentence on the free tier (or that there
    // isn't one), verified against the live pricing page. Pages that have it
    // show a pricing section, so only add it with a fresh checkedOn.
    "tiers": [                   // optional researched block; all fields below
      {                          // travel together when tiers is present
        "name": "Business",
        "monthly": 14,           // USD/month billed monthly; null = not offered
        "annualPerMonth": null,  // USD/month billed annually; null = not offered
        "per": "user",           // "user" | "workspace" | "flat"
        "limits": "Unlimited meetings and history.",  // numeric caps, one line
        "notes": null
      }
    ],
    "freeTierCaps": "Unlimited meetings, 30 days of history.", // numeric caps in one line, or "no free tier"
    "billingTerms": "monthly only, no annual plan",  // says plainly when there is NO annual plan
    "priceChanges": [],          // only sourced changes: { what, fromUsd, toUsd, when: "YYYY-MM", source }
    "hiddenCosts": null,         // overages, add-ons, seat minimums in one line, or null
    "tiersCheckedOn": "2026-08-11",
    "tiersSources": ["https://www.granola.ai/pricing"]
  },
  "verdict": "yes",              // "yes" | "kinda" | "no"
  "verdictConfidence": "medium", // how sure we are
  "verdictSummary": "One paragraph of honest reasoning shown on the page.",
  "coreLoopDIY": "What the one-shot build actually does, in one sentence.",
  "diyTimeEstimate": "one sitting",   // "one sitting" | "multi-day" | ...
  "requirements": ["OpenAI/Anthropic API key"],  // what the DIY build needs
  "whatYouLose": ["sync across devices"],        // 3–5 honest bullets
  "moatTags": ["execution-polish", "integrations"],  // 1–3, see the list below
  "moatNotes": "polish/sync/collaboration",      // optional freeform aside, null is fine
  "whyPeopleStillPay": "One honest paragraph.",
  "priorArt": [                  // DIY building blocks & inspiration for builders, [] if none
    { "name": "quill", "url": "https://github.com/...", "desc": "open-source alternative" }
  ],
  "alternatives": [              // curated FINISHED free/OSS products, [] if none — see the rules below
    {
      "name": "AppFlowy",
      "url": "https://appflowy.io",          // homepage the visitor lands on
      "type": "open-source",                 // "open-source" | "free"
      "repo": "https://github.com/AppFlowy-IO/AppFlowy",  // required if open-source, null if "free"
      "platforms": ["macos", "self-hosted"], // 1+ of: web, macos, windows, linux, ios, android, self-hosted, cli, browser-extension
      "desc": "Notion, except your data lives on your disk.",  // one dry line, site voice
      "stars": 64100,                        // GitHub stars at check time; null for "free"
      "lastCommit": "2026-07",               // "YYYY-MM"; null for "free"
      "selfHost": "one-click",               // what running it costs: "hosted" | "one-click" | "docker" | "ops"
      "checkedOn": "2026-08-05",             // when you verified it's real, free, and alive
      "facts": {                             // optional verified fact block, see rules below
        "license": "AGPL-3.0",               // SPDX id, "proprietary-free", or null
        "runs": "both",                      // "local" | "cloud" | "both" | "self-hosted"
        "install": "Desktop download; docker compose for the server",  // one line
        "engines": null,                     // AI tools: models/backends it uses, else null
        "dataFormat": "Markdown files on disk",  // where user data lives, or null
        "gapVsPaid": "One sentence: the single biggest thing it does WORSE than the paid app.",
        "setupBlocker": null,                // first real obstacle for a non-expert; null = installs clean
        "sources": ["https://github.com/AppFlowy-IO/AppFlowy/blob/main/LICENSE"],
        "checkedOn": "2026-08-11"
      }
    }
  ],
  "rejectedAlternatives": [        // the obvious recommendations that FAIL the bar, [] if none
    { "name": "Serposcope", "url": "https://serposcope.serphacker.com", "desc": "Once the obvious free answer; archived in 2024." }
  ],
  "relatedSlugs": ["otter-ai"],  // curated related apps (optional)
  "pagePriority": 5,             // 1–5 editorial weight for default ordering
  "verifiedOneShot": false,      // true only with a linked proof repo
  "notes": "One-line editorial for the entry.",
  "prompt": "Build me a ...",    // the one-shot prompt — see prompt rules below
  "promptCurated": true          // false = generated from coreLoopDIY, PRs welcome
}
```

Thin entries are welcome, but every key has to be there — use `null` for the prose
you don't have and `[]` for the lists (`subcategory`, `coreLoopDIY`,
`diyTimeEstimate`, `moatNotes`, `whyPeopleStillPay`, `notes` and `priceMonthly` all
take `null`). `npm run validate` checks the whole dataset and tells you exactly
what's off; CI runs the same check on your PR. Improving a `promptCurated: false`
prompt into a real hand-written one (and flipping the flag) is one of the most
valuable PRs you can send.

`priceMonthly` is the price for **one** seat when `pricing.unit` is `per-seat` — the
site multiplies it by the team size you type in. Pick the unit that matches how the
vendor actually charges: `flat` (one price per month), `per-seat` (per user),
`usage` (metered credits/events), `one-time` (a single purchase), `custom` ("contact
sales"). If a plan is billed yearly, convert to the monthly equivalent and say so in
`pricing.basis`.

Also add the app's favicon as `public/icons/<slug>.png` (64px; a favicon service export
is fine).

## Verdict criteria

- 🟢 **yes** — a competent AI coding agent produces a usable personal version in one
  session, self-hosted or local, no hard third-party dependency (or only trivial API
  keys). The core value survives without the SaaS's network/data moat.
- 🟡 **kinda** — buildable in a weekend but with real gaps (mobile app, sync,
  integrations, OAuth pain). Say what the gaps are.
- 🔴 **not really** — the value IS the network, the data, the infra, or compliance.
  These entries make the site credible: explain *why* it survives, and give the prompt
  for the closest honest consolation build (or say "don't").

## Moat tags

`moatTags` answers one question: structurally, why do people still pay for this
instead of building a replacement? Pick 1–3, strongest first, from this list — don't
invent new ones. `moatNotes` is free text for anything the tags miss.

- `network-effects` — it's better because other people are on it: social graphs,
  communities, respondent pools, audience reach.
- `marketplace-liquidity` — two sides that need each other: buyers and sellers,
  merchants and customers.
- `proprietary-data` — data you can't rebuild: indexes, crawls, live feeds, archives,
  maps, unique datasets.
- `proprietary-models` — custom-trained or frontier models plus the compute and
  inference behind them.
- `switching-costs` — your own accumulated history, config and habits make leaving
  painful, whatever the features are like.
- `integrations` — connector breadth and the endless upkeep: OAuth, calendars, banks,
  plugin ecosystems, platform partnerships.
- `compliance-regulatory` — regulated ground: payments licensing, payroll, tax, KYC,
  HIPAA/SOC2, legal exposure.
- `brand-trust` — people pay because it's *this* vendor: security assurance,
  credibility with counterparties, nobody-got-fired.
- `scale-infra` — infrastructure one person can't match: global hosting, uptime
  guarantees, media pipelines, email deliverability, monitoring fleets.
- `hardware` — physical devices, or data only the vendor's hardware produces.
- `collaboration` — it only pays off when the whole team is on it: shared editing,
  presence, permissions, team workflow.
- `content-rights` — licensed content, music and media rights, curriculum, template
  and asset libraries.
- `execution-polish` — polish, reliability, sync quality, workflow depth, import
  fidelity. This is execution, not structure — it's the moat AI erodes. An entry
  tagged *only* `execution-polish` is saying there's nothing structural left, so be
  honest either way.

## Alternatives rules

`alternatives` is the escape hatch: finished free/open-source products a
**non-builder** could adopt today instead of paying. It is NOT the same as
`priorArt` (building blocks and inspiration for people who will build). Max 8,
best first. Every entry must clear all four bars:

1. **A finished product** — installable app or usable hosted service. Not a
   library, framework, or API. A polished self-hosted app (one container, real
   docs, real website) counts; a bare build-from-source repo does not.
2. **Actually free, indefinitely** — a real OSS license, or a free tier that
   genuinely covers replacing the paid app long-term. No trials, no crippled
   tiers.
3. **Real and maintained** — not archived, active within ~12 months, real
   adoption (rough bar: 500+ stars or active releases plus a real docs site).
4. **An alternative to this app's core job**, not an adjacent tool.

`type: "free"` means closed-source freeware or a genuinely sufficient free tier —
`repo`, `stars` and `lastCommit` are `null` for those. `selfHost` is honest about
what "free" costs to run: `hosted` (they run it), `one-click` (installer or
desktop app), `docker` (a container and a compose file), `ops` (a real stack —
databases, proxies, upkeep). Write `desc` in site voice (dry, honest), never the
vendor's marketing line.

`facts` is optional per entry: verifiable facts checked against live primary
sources (license file, repo, docs, pricing page), each block carrying its own
`sources` and `checkedOn`. Inside it `null` is a finding, not a blank:
`setupBlocker: null` means "verified to install clean", `engines: null` means
"not an AI tool". Never guess a fact: leave the whole block off rather than
padding it.

`rejectedAlternatives` captures the tools everyone recommends that FAIL the bar
(archived, trial-only, a template rather than a product) with the reason in
`desc` — the site shows these so readers stop wasting evenings on them. `url`
may be `null`. Max 8, and the reason must be verifiable, not a vibe. One heads-up: adding your own
product to `alternatives` lists across the directory will get the PR closed —
suggest it for the one app it genuinely replaces and let the bar decide.

## Prompt rules

The prompt is the product. It must be:

- **Genuinely runnable** — someone pastes it into Claude Code / Codex / Cursor in an
  empty folder and gets a working thing. No hand-waving.
- **Opinionated about stack** — pick one; don't offer menus.
- **Explicit about scope** — say what's included AND what's deliberately out.
- **Honest** — no accounts/cloud/telemetry unless the app genuinely needs it; secrets
  go in `.env`; include README/permissions notes where relevant.
- **Phased**, in the house format below. Agents that are handed a whole product in
  one paragraph build a plausible-looking shell; agents handed one module at a time
  with a check to pass build something that works.

### The phased format

Prompts are being migrated to a fixed structure, 80–150 lines, ten apps at a batch.
`AGENT_VIBE.md` tracks which are converted. Use `###` headings — the prompt is
embedded under an existing `##` heading in the generated project pack, so `##`
inside a prompt breaks that document's hierarchy.

```
Build me <thing> to replace <App>. Build it in phases, in the order below. Do not
write the whole <thing> in one pass. Finish a phase, run its "Done when" check,
fix what fails, and only then start the next phase.

### Stack (fixed, do not substitute)
### Data model (create this before Phase 1)
### Phase 1 · <name>
Build: ...
Done when: <a check the builder can actually run or see>
Do not build yet: <what belongs to a later phase>
### Phase 2 · ...
### Out of scope (and why)
### README must contain
```

Rules for the phases themselves:

- **Order by dependency, not by importance.** Identity and storage before the
  features that need them; the thing most likely to kill the project first, while
  abandoning it is still cheap.
- **Every phase ends in a check that can fail.** "Done when: it works" is not a
  check. "Done when: two pageviews 31 minutes apart are two sessions, both
  bouncing" is.
- **Name the trap.** Where a phase has one detail that wastes an afternoon — a WAV
  format, a Safari clipboard quirk, a weighted character count — say it in the
  phase, with the reason. That sentence is worth more than the rest of the phase.
- **Verify external facts before writing them in.** API pricing, tiers, model
  names, library APIs and CLI flags all drift. A confidently wrong version number
  sends the builder somewhere the docs contradict.
- **`Out of scope (and why)`** carries the honesty: not just what is missing, but
  what the vendor's price is actually buying.

## Build kits

A build kit is the beginner-friendly, per-app development guide behind two
surfaces: the project pack on the verdict page (real per-project Markdown files
instead of the generic templates) and the step-by-step tracker at `/<slug>/build`.
One file per app in `data/builds/<slug>.json`; apps without one keep the generic
pack and the phases parsed from the prompt. `npm run validate` checks every kit.

```jsonc
{
  "slug": "carrd", "version": 1,          // bump version when steps change materially
  "summary": "What you have when every item is ticked.",
  "time": "one sitting",                    // one sitting | weekend | multi-day
  "stack": [{ "part": "Runtime", "choice": "Node 22", "why": "..." }],
  "prerequisites": [{                       // everything to have BEFORE step 1
    "id": "node", "kind": "tool",           // tool | account | key | asset | decision
    "name": "Node.js 22 or newer",
    "why": "what breaks without it",
    "get": "exactly where and how, for a beginner",
    "verify": "node --version prints v22+",  // optional
    "cost": "free",                          // "free" is an answer; API keys say what they cost
    "optional": false, "url": "https://nodejs.org"
  }],
  "env": [{ "name": "PORT", "example": "3000", "required": true, "secret": false, "where": "where the value comes from" }],
  "phases": [{
    "id": "p1", "title": "Build pipeline", "goal": "one paragraph",
    "productOnly": false,                    // true = product-builder mode only
    "steps": [{ "id": "p1s1", "do": "...", "detail": "...", "commands": ["..."], "files": ["..."], "snippet": "..." }],
    "check": ["falsifiable, one per line"],   // rendered as tickable items
    "traps": ["the detail that wastes an afternoon"]
  }],
  "product": {                               // product-builder extras
    "outcome": "...", "architecture": [{ "module": "...", "owns": "...", "swap": "..." }],
    "operations": { "backup": "...", "restore": "...", "monitoring": "...", "incident": "..." },
    "releaseGate": ["..."]
  },
  "notIncluded": ["what this does not replace, and why"],
  "after": ["ideas once v1 works"]           // optional
}
```

Rules the validator enforces, and why:

- **Every prerequisite says how to get it and what it costs.** The point of the
  kit is that a beginner is never stuck before step one. "An API key" is not a
  prerequisite; "Stripe test-mode secret key from dashboard.stripe.com >
  Developers > API keys, free in test mode" is.
- **Every phase has at least two steps and at least one check.** One step is not
  a phase, and a check that cannot fail is a wish.
- **Ids are stable.** Progress in the tracker is saved against them, so renaming
  an id resets a visitor's ticks; bumping `version` does that deliberately.
- **At least one phase is available in indie mode.** `productOnly` phases carry
  the operations and distribution work a solo builder can skip.
- **No em dashes**, same as everywhere else on the site.

## House rules

- Verdicts are editorial and honest — sponsorships never buy verdicts, and vote counts
  are never faked.
- Prices drift: check the app's pricing page when you touch an entry.
- No em dashes in UI copy; use `·`.
- One app per PR keeps review fast.
