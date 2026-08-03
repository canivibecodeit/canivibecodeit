/* Every app entry is a PR, so the schema check has to be the reviewer that never
   gets tired: shape, vocabularies, and the fields the pages actually read.
   Run with `npm run validate`. No dependencies, on purpose. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CATEGORIES, MOAT_TAGS, VERDICTS } from '../src/lib/apps.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'data/apps');
const iconsDir = path.join(root, 'public/icons');

// Style-guide rules are warnings by default so the existing backlog does not turn
// CI red. `npm run validate -- --strict` fails on them, for the day it is empty.
const strict = process.argv.includes('--strict');
const verbose = process.argv.includes('--verbose');
const today = new Date().toISOString().slice(0, 10);

const UNITS = ['flat', 'per-seat', 'usage', 'one-time', 'custom'];

// scripts/prompt-style-guide.md, the parts a script can actually check.
const MARKETING = [
  'seamless',
  'powerful',
  'beautiful',
  'delightful',
  'robust',
  'blazing',
  'intuitive',
  'production-ready',
];
const COPY_FIELDS = ['tagline', 'verdictSummary', 'coreLoopDIY', 'moatNotes', 'whyPeopleStillPay', 'notes', 'prompt'];

// The guide's required shape: an opening line ending in "Requirements:", then flat
// "- " bullets. Both exemplars (granola, calendly) pass; every generated prompt in
// the repo fails, which is the point. promptCurated is self-reported and wrong in
// both directions, so the shape is the only claim that can be verified.
const promptShape = (prompt) => {
  const lines = prompt.split('\n');
  return {
    lines: lines.length,
    bullets: lines.filter((l) => l.startsWith('- ')).length,
    opener: lines.slice(0, 2).join(' ').includes('Requirements:'),
  };
};

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrArray = (v) => Array.isArray(v) && v.every((x) => isStr(x));

// Every key every entry carries today. A missing one is a PR that copied an old
// template; the pages read all of them.
const REQUIRED = {
  slug: isStr,
  name: isStr,
  domain: isStr,
  category: isStr,
  subcategory: (v) => v === null || typeof v === 'string',
  tagline: isStr,
  priceMonthly: (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0),
  pricing: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  verdict: isStr,
  verdictConfidence: isStr,
  verdictSummary: isStr,
  coreLoopDIY: (v) => v === null || typeof v === 'string',
  diyTimeEstimate: (v) => v === null || typeof v === 'string',
  requirements: isStrArray,
  whatYouLose: isStrArray,
  moatTags: (v) => Array.isArray(v),
  moatNotes: (v) => v === null || typeof v === 'string',
  whyPeopleStillPay: (v) => v === null || typeof v === 'string',
  priorArt: (v) => Array.isArray(v),
  pagePriority: (v) => typeof v === 'number' && v >= 1 && v <= 5,
  verifiedOneShot: (v) => typeof v === 'boolean',
  notes: (v) => v === null || typeof v === 'string',
  prompt: isStr,
  promptCurated: (v) => typeof v === 'boolean',
};

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const slugs = new Set(files.map((f) => path.basename(f, '.json')));
const problems = [];
const warnings = new Map(); // rule -> [messages]

for (const file of files) {
  const bad = (msg) => problems.push(`${file}: ${msg}`);
  const warn = (rule, msg) => {
    if (!warnings.has(rule)) warnings.set(rule, []);
    warnings.get(rule).push(`${file}: ${msg}`);
  };
  let app;
  try {
    app = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    bad(`invalid JSON — ${err.message}`);
    continue;
  }

  if (app.slug !== path.basename(file, '.json')) {
    bad(`slug "${app.slug}" does not match the filename`);
  }
  for (const [key, ok] of Object.entries(REQUIRED)) {
    if (!(key in app)) bad(`missing "${key}"`);
    else if (!ok(app[key])) bad(`"${key}" has the wrong type or value`);
  }

  if (!(app.verdict in VERDICTS)) {
    bad(`verdict "${app.verdict}" is not one of ${Object.keys(VERDICTS).join(' | ')}`);
  }
  if (!(app.category in CATEGORIES)) {
    bad(`category "${app.category}" is not a key in src/lib/apps.js CATEGORIES`);
  }

  if (Array.isArray(app.moatTags)) {
    if (app.moatTags.length < 1 || app.moatTags.length > 3) {
      bad(`moatTags needs 1–3 tags, found ${app.moatTags.length}`);
    }
    for (const tag of app.moatTags) {
      if (!(tag in MOAT_TAGS)) bad(`moatTags: "${tag}" is not a known moat tag`);
    }
    if (new Set(app.moatTags).size !== app.moatTags.length) bad('moatTags has duplicates');
  }

  if (app.pricing && typeof app.pricing === 'object') {
    if (!UNITS.includes(app.pricing.unit)) {
      bad(`pricing.unit "${app.pricing.unit}" is not one of ${UNITS.join(' | ')}`);
    }
    // "Prices drift, receipts matter" only holds if the receipt has a real date on it.
    const checked = app.pricing.checkedOn;
    if (!isStr(checked) || !/^\d{4}-\d{2}-\d{2}$/.test(checked)) {
      bad(`pricing.checkedOn "${checked}" is not a YYYY-MM-DD date`);
    } else if (checked > today) {
      bad(`pricing.checkedOn "${checked}" is in the future`);
    }
    if (app.pricing.source != null && !/^https?:\/\//.test(app.pricing.source)) {
      bad(`pricing.source "${app.pricing.source}" is not a URL`);
    }
  }

  if (Array.isArray(app.priorArt)) {
    app.priorArt.forEach((p, i) => {
      if (!p || typeof p !== 'object' || !isStr(p.name) || !isStr(p.url)) {
        bad(`priorArt[${i}] needs a name and a url`);
      } else if (!/^https?:\/\//.test(p.url)) {
        // The page renders these as anchors, so a placeholder ships a dead link.
        // Use [] when there is no prior art.
        bad(`priorArt[${i}].url "${p.url}" is not a URL`);
      }
    });
  }
  if (app.relatedSlugs !== undefined && !isStrArray(app.relatedSlugs)) {
    bad('relatedSlugs must be an array of slugs');
  } else {
    for (const r of app.relatedSlugs ?? []) {
      if (!slugs.has(r)) bad(`relatedSlugs: "${r}" is not an entry in data/apps`);
    }
  }

  // The app page reads /icons/<slug>.png unconditionally; a missing file is a
  // broken image on a live page, not a cosmetic problem.
  if (isStr(app.slug) && !existsSync(path.join(iconsDir, `${app.slug}.png`))) {
    bad(`no icon at public/icons/${app.slug}.png`);
  }

  // --- style guide, warnings by default ---

  if (isStr(app.prompt)) {
    // Shape only. The guide's 15-to-30-line rule is deliberately not checked: both
    // of its own exemplars are 14 lines, so the rule as written would fail them.
    const { bullets, opener } = promptShape(app.prompt);
    if (!opener || bullets < 5) {
      warn(
        'prompt-shape',
        `prompt is not in the house shape (${bullets} bullets${opener ? '' : ', no "Requirements:" opener'})`,
      );
      if (app.promptCurated === true) {
        warn('promptCurated-mislabelled', 'promptCurated is true but the prompt is not in the house shape');
      }
    }
    const found = MARKETING.filter((w) => app.prompt.toLowerCase().includes(w));
    if (found.length) warn('marketing-words', `prompt uses ${found.join(', ')}`);
  }

  for (const field of COPY_FIELDS) {
    if (typeof app[field] === 'string' && app[field].includes('—')) {
      warn('em-dash', `${field} contains an em dash, the house rule is ·`);
    }
  }
}

if (strict) {
  for (const list of warnings.values()) problems.push(...list);
  warnings.clear();
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s) in ${files.length} app files:\n`);
  problems.forEach((p) => console.error(`  ${p}`));
  process.exit(1);
}

console.log(`✓ ${files.length} app files pass`);

if (warnings.size) {
  const total = [...warnings.values()].reduce((n, l) => n + l.length, 0);
  console.log(`\n${total} style-guide warning(s) · scripts/prompt-style-guide.md`);
  for (const [rule, list] of [...warnings].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${rule} · ${list.length}`);
    (verbose ? list : list.slice(0, 3)).forEach((m) => console.log(`    ${m}`));
    if (!verbose && list.length > 3) console.log(`    ...and ${list.length - 3} more (--verbose)`);
  }
  console.log('\nWarnings do not fail the build. Run with --strict once a rule is clean.');
}
