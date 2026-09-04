/* Build kits: the per-app, hand-authored development guide behind the project
   pack and the /<slug>/build tracker.

   One kit per app in data/builds/<slug>.json. Where a kit exists it drives both
   surfaces from one source: the pack renders real per-project Markdown files
   (README, BUILD_PLAN, .env.example and the product set), and the tracker
   renders prerequisites, environment variables and every phase's sub-steps as
   checkable items. Apps without a kit fall back to the generic pack templates
   and to the phases parsed from the prompt, exactly as before.

   The shape is validated by validateKit() below and enforced across the
   directory by scripts/validate-builds.mjs, which npm run validate calls. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DELIVERY_ORDER } from './build-plan.js';

// Resolved from the working directory like data/apps (see apps.js).
const KITS_DIR = process.env.BUILDS_DIR || path.resolve('data/builds');

export const PREREQ_KINDS = ['tool', 'account', 'key', 'asset', 'decision'];
export const TIME_ESTIMATES = ['one sitting', 'weekend', 'multi-day'];

/* ---------- loading ---------- */

const cache = new Map();
// Same rule as apps.js: cache for the process in production, re-read in dev so
// an edit to a kit shows on the next reload. Plain Node has no import.meta.env.
const CACHE = !import.meta.env?.DEV;

export function loadKit(slug) {
  if (!/^[a-z0-9-]+$/.test(String(slug))) return null;
  if (CACHE && cache.has(slug)) return cache.get(slug);
  const file = path.join(KITS_DIR, `${slug}.json`);
  let kit = null;
  if (existsSync(file)) {
    kit = JSON.parse(readFileSync(file, 'utf8'));
  }
  if (CACHE) cache.set(slug, kit);
  return kit;
}

export function allKitSlugs() {
  if (!existsSync(KITS_DIR)) return [];
  return readdirSync(KITS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'))
    .sort();
}

/* ---------- validation ---------- */

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);
const isId = (v) => isStr(v) && /^[a-z0-9][a-z0-9-]*$/.test(v);

/* Returns a list of problem strings; empty means the kit passes. Written as a
   flat list of checks rather than a schema library so the message names the
   exact field, the same way validate-app.js does for app entries. */
export function validateKit(kit) {
  const bad = [];
  const p = (m) => bad.push(m);
  if (!kit || typeof kit !== 'object' || Array.isArray(kit)) return ['kit must be a JSON object'];

  if (!isId(kit.slug)) p('slug is required (lowercase, hyphens)');
  if (!Number.isInteger(kit.version) || kit.version < 1) p('version must be a positive integer');
  if (!isStr(kit.summary)) p('summary is required');
  if (!TIME_ESTIMATES.includes(kit.time)) p(`time must be one of ${TIME_ESTIMATES.join(' | ')}`);

  if (!Array.isArray(kit.stack) || kit.stack.length < 1) p('stack must be a non-empty array');
  else kit.stack.forEach((s, i) => {
    if (!s || !isStr(s.part) || !isStr(s.choice) || !isStr(s.why)) p(`stack[${i}] needs part, choice, why`);
  });

  const ids = new Set();
  const claim = (id, where) => {
    if (ids.has(id)) p(`${where}: duplicate id "${id}"`);
    ids.add(id);
  };

  if (!Array.isArray(kit.prerequisites) || kit.prerequisites.length < 1) p('prerequisites must be a non-empty array');
  else kit.prerequisites.forEach((r, i) => {
    const w = `prerequisites[${i}]`;
    if (!r || typeof r !== 'object') return p(`${w} must be an object`);
    if (!isId(r.id)) p(`${w}.id is required`); else claim(`pre:${r.id}`, w);
    if (!PREREQ_KINDS.includes(r.kind)) p(`${w}.kind must be one of ${PREREQ_KINDS.join(' | ')}`);
    if (!isStr(r.name)) p(`${w}.name is required`);
    if (!isStr(r.why)) p(`${w}.why is required · say what breaks without it`);
    if (!isStr(r.get)) p(`${w}.get is required · say exactly where and how`);
    if (!isStr(r.cost)) p(`${w}.cost is required ("free" is an answer)`);
    if (r.verify !== undefined && !isStr(r.verify)) p(`${w}.verify must be a string when present`);
    if (r.url !== undefined && !(isStr(r.url) && /^https?:\/\//.test(r.url))) p(`${w}.url must be an http(s) URL`);
    if (r.optional !== undefined && typeof r.optional !== 'boolean') p(`${w}.optional must be boolean`);
  });

  if (!Array.isArray(kit.env)) p('env must be an array (empty is allowed)');
  else kit.env.forEach((e, i) => {
    const w = `env[${i}]`;
    if (!e || typeof e !== 'object') return p(`${w} must be an object`);
    if (!isStr(e.name) || !/^[A-Z][A-Z0-9_]*$/.test(e.name)) p(`${w}.name must be UPPER_SNAKE_CASE`);
    if (!isStr(e.example)) p(`${w}.example is required (a placeholder for secrets)`);
    if (typeof e.required !== 'boolean') p(`${w}.required must be boolean`);
    if (typeof e.secret !== 'boolean') p(`${w}.secret must be boolean`);
    if (!isStr(e.where)) p(`${w}.where is required · where the value comes from`);
  });

  if (!Array.isArray(kit.phases) || kit.phases.length < 2) p('phases must have at least 2 entries');
  else kit.phases.forEach((ph, i) => {
    const w = `phases[${i}]`;
    if (!ph || typeof ph !== 'object') return p(`${w} must be an object`);
    if (!isId(ph.id)) p(`${w}.id is required`); else claim(ph.id, w);
    if (!isStr(ph.title)) p(`${w}.title is required`);
    if (!isStr(ph.goal)) p(`${w}.goal is required`);
    if (ph.productOnly !== undefined && typeof ph.productOnly !== 'boolean') p(`${w}.productOnly must be boolean`);
    if (!Array.isArray(ph.steps) || ph.steps.length < 2) p(`${w}.steps must have at least 2 entries`);
    else ph.steps.forEach((s, j) => {
      const sw = `${w}.steps[${j}]`;
      if (!s || typeof s !== 'object') return p(`${sw} must be an object`);
      if (!isId(s.id)) p(`${sw}.id is required`); else claim(s.id, sw);
      if (!isStr(s.do)) p(`${sw}.do is required`);
      if (s.detail !== undefined && !isStr(s.detail)) p(`${sw}.detail must be a string when present`);
      if (s.commands !== undefined && !isStrArray(s.commands)) p(`${sw}.commands must be an array of strings`);
      if (s.files !== undefined && !isStrArray(s.files)) p(`${sw}.files must be an array of strings`);
      if (s.snippet !== undefined && !isStr(s.snippet)) p(`${sw}.snippet must be a string when present`);
    });
    if (!isStrArray(ph.check) || ph.check.length < 1) p(`${w}.check must be a non-empty array · a phase without a falsifiable check is a wish`);
    if (ph.traps !== undefined && !isStrArray(ph.traps)) p(`${w}.traps must be an array of strings`);
  });
  if (Array.isArray(kit.phases) && kit.phases.length && kit.phases.every((ph) => ph?.productOnly)) {
    p('at least one phase must be available in indie mode');
  }

  if (!kit.product || typeof kit.product !== 'object') p('product is required');
  else {
    const pr = kit.product;
    if (!isStr(pr.outcome)) p('product.outcome is required');
    if (!Array.isArray(pr.architecture) || pr.architecture.length < 1) p('product.architecture must be a non-empty array');
    else pr.architecture.forEach((m, i) => {
      if (!m || !isStr(m.module) || !isStr(m.owns) || !isStr(m.swap)) p(`product.architecture[${i}] needs module, owns, swap`);
    });
    const ops = pr.operations;
    if (!ops || typeof ops !== 'object') p('product.operations is required');
    else for (const k of ['backup', 'restore', 'monitoring', 'incident']) {
      if (!isStr(ops[k])) p(`product.operations.${k} is required`);
    }
    if (!isStrArray(pr.releaseGate) || pr.releaseGate.length < 1) p('product.releaseGate must be a non-empty array');
  }

  if (!isStrArray(kit.notIncluded) || kit.notIncluded.length < 1) p('notIncluded must be a non-empty array');
  if (kit.after !== undefined && !isStrArray(kit.after)) p('after must be an array of strings when present');

  // House rule: no em dashes in anything a visitor reads.
  const scan = (v, where) => {
    if (typeof v === 'string' && v.includes('—')) p(`${where} contains an em dash · use "·"`);
    else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, where ? `${where}.${k}` : k);
  };
  scan(kit, '');

  return bad;
}

/* ---------- tracker model ---------- */

/* Which phases a mode shows. Indie skips productOnly phases; product shows all. */
export function phasesFor(kit, mode) {
  return kit.phases.filter((ph) => mode === 'product' || !ph.productOnly);
}

/* Counts the tracker shows and the CTA quotes. Steps only, not checks: a
   visitor reads "31 steps" as work, and the checks are how they know a step
   is done, not more work. */
export function kitCounts(kit, mode = 'indie') {
  const phases = phasesFor(kit, mode);
  const steps = phases.reduce((n, ph) => n + ph.steps.length, 0);
  return { prerequisites: kit.prerequisites.length, phases: phases.length, steps };
}

/* ---------- pack generation ---------- */

const bullets = (items, empty) => (items?.length ? items.map((x) => `- ${x}`).join('\n') : `- ${empty}`);
const fence = (lines) => `\`\`\`sh\n${lines.join('\n')}\n\`\`\``;

export const makeBundle = (baseName, mode, files) => `You are building a ${mode} version of ${baseName}.

Create the following project files first, then implement the application by following them. Keep the files updated as decisions change. Do not collapse this into a single README or prompt.

${files.map((file) => `===== ${file.path} =====\n${file.content}`).join('\n\n')}`;

const envExample = (kit) => {
  if (!kit.env.length) {
    return `# This build needs no environment variables. Add one here the moment a\n# phase introduces it, with a comment saying where the value comes from.\n`;
  }
  const lines = ['# Copy to .env and fill in. Never commit .env; this file documents it.', ''];
  for (const e of kit.env) {
    lines.push(`# ${e.required ? 'Required' : 'Optional'}${e.secret ? ' · secret' : ''}. ${e.where}`);
    lines.push(`${e.name}=${e.example}`);
    lines.push('');
  }
  return lines.join('\n');
};

const prereqLines = (kit) =>
  kit.prerequisites
    .map((r) => {
      const bits = [`- [ ] **${r.name}**${r.optional ? ' (optional)' : ''} · ${r.cost}`, `  - Why: ${r.why}`, `  - Get it: ${r.get}`];
      if (r.verify) bits.push(`  - Verify: ${r.verify}`);
      return bits.join('\n');
    })
    .join('\n');

const stackTable = (kit) =>
  ['| Part | Choice | Why |', '| --- | --- | --- |', ...kit.stack.map((s) => `| ${s.part} | ${s.choice} | ${s.why} |`)].join('\n');

// `heading` is the finished prefix ("Phase 3", "M3"): the two call sites
// differ in whether a space follows the label.
const phaseMarkdown = (ph, heading) => {
  const out = [`## ${heading} · ${ph.title}${ph.productOnly ? ' (production only)' : ''}`, '', ph.goal, '', '### Steps', ''];
  ph.steps.forEach((s, i) => {
    out.push(`${i + 1}. ${s.do}`);
    if (s.detail) out.push(`   ${s.detail}`);
    if (s.files?.length) out.push(`   Files: ${s.files.map((f) => `\`${f}\``).join(', ')}`);
    if (s.commands?.length) out.push('', '   ' + fence(s.commands).split('\n').join('\n   '), '');
    if (s.snippet) out.push('', '   ' + s.snippet.split('\n').join('\n   '), '');
  });
  out.push('', '### Done when', '', ph.check.map((c) => `- [ ] ${c}`).join('\n'));
  if (ph.traps?.length) out.push('', '### Watch out', '', bullets(ph.traps));
  return out.join('\n');
};

const firstCommands = (kit) => {
  for (const ph of kit.phases) for (const s of ph.steps) if (s.commands?.length) return s.commands;
  return null;
};

export function kitPack(app, kit, mode) {
  const baseName = app.name.split(' / ')[0];
  const phases = phasesFor(kit, mode);
  const losses = [...(kit.notIncluded ?? []), ...(app.whatYouLose ?? [])];
  const seen = new Set();
  const limits = losses.filter((l) => (seen.has(l.toLowerCase()) ? false : (seen.add(l.toLowerCase()), true)));
  const quick = firstCommands(kit);

  const envFile = { path: '.env.example', content: envExample(kit) };
  // The prompt is the compact brief the kit expands: it carries the data model
  // and the exact acceptance wording, and an agent should read both.
  const briefFile = app.prompt
    ? { path: 'BRIEF.md', content: `# Build brief · ${baseName}\n\nThe one-shot brief this plan expands. \`BUILD_PLAN.md\` (or \`MILESTONES.md\`) is the same sequence broken into steps and checks; where the two disagree, the plan wins.\n\n${app.prompt}` }
    : null;
  const withBrief = (files) => (briefFile ? [files[0], briefFile, ...files.slice(1)] : files);

  if (mode === 'indie') {
    return withBrief([
      {
        path: 'README.md',
        content: `# ${baseName} · indie build

${kit.summary}

Estimated effort: **${kit.time}**. Work \`BUILD_PLAN.md\` top to bottom · every phase ends in a check that has to pass before the next one starts.

## Stack

${stackTable(kit)}

## Before you start

Have every one of these ready. The plan assumes them from step one.

${prereqLines(kit)}

## Quick start

${quick ? fence(quick) : 'Follow Phase 1 in `BUILD_PLAN.md`; it creates the project.'}

Then copy \`.env.example\` to \`.env\` and fill in the values it documents.

## Honest limits

This build deliberately does not replace:

${bullets(limits, 'none documented')}

If one of those is essential to you, that is the reason to keep paying for ${baseName}, and the README should say so rather than pretend.`,
      },
      {
        path: 'AGENTS.md',
        content: `# Agent instructions · ${baseName} indie build

- Read \`README.md\` and \`BUILD_PLAN.md\` before writing code. The stack is fixed: ${kit.stack.map((s) => s.choice).join(', ')}. Do not substitute.
- Work one phase at a time, in order. Do not start a phase until every "Done when" item of the previous one passes.
- Prefer the fewest moving parts that satisfy the step. No frameworks, services or dependencies the plan does not name.
- Secrets live in \`.env\`, never in source or logs. Keep \`.env.example\` current when a variable is introduced.
- Do not invent cryptography, security guarantees, APIs or compliance claims.
- Add a focused test for every destructive, security-sensitive or data-loss path the plan names.
- Run the project checks before declaring a phase complete, and record any deliberate shortcut in the README under "Tradeoffs".
${phases.some((ph) => ph.traps?.length) ? `\n## Known traps\n\n${bullets(phases.flatMap((ph) => ph.traps ?? []))}` : ''}`,
      },
      {
        path: 'BUILD_PLAN.md',
        content: `# Build plan · ${baseName}

${kit.summary}

Phases are in dependency order. Each ends in a "Done when" list; treat an unticked item as a blocker, not a note.

${phases.map((ph, i) => phaseMarkdown(ph, `Phase ${i + 1}`)).join('\n\n')}

## Not in this build

${bullets(kit.notIncluded)}${kit.after?.length ? `\n\n## After v1, if you want it\n\n${bullets(kit.after)}` : ''}`,
      },
      envFile,
    ]);
  }

  const pr = kit.product;
  return withBrief([
    {
      path: 'PRODUCT.md',
      content: `# ${baseName} · product brief

## Problem

${app.verdictSummary || app.notes || `Rebuild the useful core of ${baseName} as a product you own.`}

## Product outcome

${pr.outcome}

## Target user

A builder who needs a maintainable product foundation, not a one-off demo.

## Required capabilities

${bullets(app.requirements, 'Implement the core workflow described in ARCHITECTURE.md')}

## Explicit non-goals for v1

${bullets(limits, 'none documented')}

## Success criteria

${bullets(pr.releaseGate)}`,
    },
    {
      path: 'ARCHITECTURE.md',
      content: `# Architecture · ${baseName}

## Stack

${stackTable(kit)}

## Modules

Each module has one owner concern and a documented way to replace it.

| Module | Owns | How to replace it |
| --- | --- | --- |
${pr.architecture.map((m) => `| ${m.module} | ${m.owns} | ${m.swap} |`).join('\n')}

## Configuration

Every runtime setting is an environment variable documented in \`.env.example\`, validated at startup, with a safe local default wherever one exists.

${kit.env.length ? kit.env.map((e) => `- \`${e.name}\` · ${e.required ? 'required' : 'optional'}${e.secret ? ', secret' : ''} · ${e.where}`).join('\n') : '- No environment variables are needed for this build.'}

## Production baseline

- Security: least privilege, input validation at every boundary, secret redaction in logs, rate limits on abuse-prone paths, no invented security primitives.
- Data: explicit schema and migrations, transactional writes where integrity matters, backup and restore procedures that have been exercised.
- Integrations: adapters around third-party providers, idempotent webhook or job processing, bounded retries, timeouts.
- Observability: structured logs with request or operation ids, an error-tracking hook, and health and readiness checks where a server exists.
- Quality: unit tests for domain rules, integration tests at module boundaries, one end-to-end test of the critical path.

## Decision records

For each dependency in the stack table, keep a short note: why it was chosen, its failure mode, and how it is replaced. Do not add infrastructure until a requirement in \`PRODUCT.md\` justifies it.`,
    },
    {
      path: 'AGENTS.md',
      content: `# Agent instructions · ${baseName} product build

- Read \`PRODUCT.md\` and \`ARCHITECTURE.md\` before changing code. The stack is fixed: ${kit.stack.map((s) => s.choice).join(', ')}.
- Implement milestone by milestone from \`MILESTONES.md\`; keep each change reviewable and leave the application runnable at every commit.
- Treat authentication, payments, encryption, imports, webhooks and destructive actions as high-risk boundaries when present.
- Never invent cryptography or silently weaken a requirement to make a check pass.
- Put every external service behind an interface with a deterministic fake for tests.
- Add migrations and rollback or recovery notes for every persistent data change.
- Log useful operational context without credentials, tokens, passwords or personal data.
- Update documentation and run every check before completing a milestone.
${kit.phases.some((ph) => ph.traps?.length) ? `\n## Known traps\n\n${bullets(kit.phases.flatMap((ph) => ph.traps ?? []))}` : ''}`,
    },
    {
      path: 'MILESTONES.md',
      content: `# Delivery milestones · ${baseName}

Estimated effort: **${kit.time}** for the indie phases; the production-only milestones add the trust and operability layer.

${phases.map((ph, i) => phaseMarkdown(ph, `M${i + 1}`)).join('\n\n')}`,
    },
    {
      path: 'OPERATIONS.md',
      content: `# Operations · ${baseName}

## Backup

${pr.operations.backup}

## Restore

${pr.operations.restore}

Do a restore drill before the first real user, and write the date here when it passes.

## Monitoring

${pr.operations.monitoring}

## Incident checklist

${pr.operations.incident}

1. Contain the issue without destroying evidence or user data.
2. Record the timeline and affected scope.
3. Rotate exposed secrets and revoke compromised sessions or credentials.
4. Restore from a verified backup when needed.
5. Document the root cause, the remediation and the regression test.

## Release gate

${pr.releaseGate.map((g) => `- [ ] ${g}`).join('\n')}

## Launch constraint

Do not market omitted ${baseName} capabilities as implemented. The non-goals in \`PRODUCT.md\` remain user-visible limitations until they are deliberately delivered.`,
    },
    envFile,
  ]);
}

/* The generic templates, unchanged from before kits existed. Every app without
   a kit keeps rendering exactly these. Ported out of the page so the two
   generators live side by side and can be tested. */
export function genericPack(app, mode) {
  const baseName = app.name.split(' / ')[0];
  const requirementLines = (app.requirements ?? []).map((item) => `- ${item}`).join('\n') || '- Implement the core workflow described in the build brief.';
  const lossLines = (app.whatYouLose ?? []).map((item) => `- ${item}`).join('\n') || '- None documented.';
  const fallbackName = app.priorArt?.[0]?.name || app.alternatives?.[0]?.name || baseName;

  if (mode === 'indie') {
    return [
      {
        path: 'README.md',
        content: `# ${baseName} indie build

## Goal

Build the smallest trustworthy replacement for the core ${baseName} workflow for one developer or a tiny team.

## Scope

${app.coreLoopDIY || app.verdictSummary || `Rebuild the useful core of ${baseName}.`}

## Quick start

1. Install the documented dependencies.
2. Copy \`.env.example\` to \`.env\`.
3. Run the development command chosen during implementation.
4. Complete the acceptance checks in \`BUILD_PLAN.md\`.

## Honest limits

This build deliberately does not replace:
${lossLines}

If those capabilities are essential, use ${fallbackName} instead of pretending the gap is solved.`,
      },
      {
        path: 'AGENTS.md',
        content: `# Agent instructions

- Optimize for a working, understandable weekend build.
- Prefer the fewest moving parts that satisfy the brief.
- Do not invent cryptography, security guarantees, APIs, or compliance claims.
- Keep secrets out of source control and logs.
- Add focused tests for destructive, security-sensitive, and data-loss paths.
- Run the project checks before declaring the build complete.
- Record any deliberate shortcut in the README under "Tradeoffs".`,
      },
      {
        path: 'BUILD_PLAN.md',
        content: `# Build plan

## Original build brief

${app.prompt}

## Required capabilities

${requirementLines}

## Delivery order

${DELIVERY_ORDER.map((step, i) => `${i + 1}. ${step.title}`).join('\n')}

## Done when

- A new user can go from clone to first successful workflow using only the README.
- The core workflow works without paid infrastructure unless the brief requires it.
- Tests cover the highest-risk behavior.
- Known limitations are explicit rather than hidden.`,
      },
      {
        path: '.env.example',
        content: `# Copy to .env and document every variable when it is introduced.
# Never put real credentials in this file.

APP_ENV=development
# Add only values required by the selected implementation.`,
      },
    ];
  }

  return [
    {
      path: 'PRODUCT.md',
      content: `# ${baseName} product brief

## Problem

${app.verdictSummary || app.notes}

## Product outcome

${app.coreLoopDIY || `Deliver a trustworthy replacement for the core ${baseName} workflow.`}

## Target user

A serious builder who needs a maintainable product foundation rather than a one-off demo.

## Required capabilities

${requirementLines}

## Explicit non-goals for v1

${lossLines}

## Success criteria

- The primary workflow is measurable end to end.
- Setup is reproducible in a clean environment.
- Failure, recovery, and support paths are documented.
- Product claims match what the implementation actually guarantees.`,
    },
    {
      path: 'ARCHITECTURE.md',
      content: `# Architecture

## Starting brief

${app.prompt}

## Boundaries

Separate the product into replaceable modules for interface, application logic, persistence, external integrations, and operational concerns. Keep domain logic independent from delivery frameworks and vendors.

## Production baseline

- Configuration: validated at startup with safe local defaults where possible.
- Security: least privilege, input validation, secret redaction, rate limits on abuse-prone paths, and no invented security primitives.
- Data: explicit schema and migrations, transactional writes where integrity matters, backup and restore instructions.
- Integrations: adapters around third-party providers, idempotent webhook or job processing, bounded retries, and timeouts.
- Observability: structured logs with request or operation IDs, an error-tracking hook, and health/readiness checks where a server exists.
- Quality: unit tests for domain rules, integration tests at module boundaries, and one end-to-end critical-path test.

## Decision records

For each major dependency, document why it was chosen, its failure mode, and how it can be replaced. Do not introduce infrastructure until a requirement justifies it.`,
    },
    {
      path: 'AGENTS.md',
      content: `# Agent instructions

- Read \`PRODUCT.md\` and \`ARCHITECTURE.md\` before changing code.
- Implement milestone by milestone; keep each change reviewable and leave the application runnable.
- Treat authentication, payments, encryption, imports, webhooks, and destructive actions as high-risk boundaries when present.
- Never invent cryptography or silently weaken a requirement to make a test pass.
- Use provider interfaces for external services and deterministic fakes in tests.
- Add migrations and rollback or recovery notes for persistent data changes.
- Log useful operational context without credentials, tokens, passwords, or personal data.
- Update documentation and run all checks before completing a milestone.`,
    },
    {
      path: 'MILESTONES.md',
      content: `# Delivery milestones

## M0 — Decisions and scaffold

- Confirm the runtime, persistence model, threat boundaries, and deployment target.
- Create a reproducible local environment and continuous checks.

## M1 — Core workflow

- Implement the smallest end-to-end product path with validation and tests.
- Keep integrations behind interfaces.

## M2 — Trust layer

- Add secure failure behavior, recovery paths, audit-relevant events, and data safeguards.
- Test abuse cases and destructive operations.

## M3 — Operability

- Add structured logs, error reporting hooks, health signals, backup/restore documentation, and deployment configuration.

## M4 — Release gate

- Run a clean-install test, critical-path end-to-end test, dependency review, and documented rollback exercise.
- Compare the shipped behavior with \`PRODUCT.md\` and publish remaining limitations.`,
    },
    {
      path: 'OPERATIONS.md',
      content: `# Operations

## Before release

- Validate configuration and secrets at startup.
- Define backup, restore, and rollback procedures and test them.
- Document logs, error tracking, health signals, and alert ownership.
- Set dependency update and vulnerability review expectations.

## Incident checklist

1. Contain the issue without destroying evidence or user data.
2. Record the timeline and affected scope.
3. Rotate exposed secrets and revoke compromised sessions or credentials.
4. Restore from a verified source when needed.
5. Document the root cause, remediation, and regression test.

## Launch constraint

Do not market omitted ${baseName} capabilities as implemented. The v1 non-goals in \`PRODUCT.md\` remain user-visible limitations until they are deliberately delivered.`,
    },
  ];
}

/* One call site: a kit when there is one, the generic templates when not. */
export function packFiles(app, kit, mode) {
  return kit ? kitPack(app, kit, mode) : genericPack(app, mode);
}
