/* Every app entry is a PR, so the schema check has to be the reviewer that never
   gets tired: shape, vocabularies, and the fields the pages actually read.
   Run with `npm run validate`. No dependencies, on purpose. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CATEGORIES, MOAT_TAGS, VERDICTS } from '../src/lib/apps.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'data/apps');

const UNITS = ['flat', 'per-seat', 'usage', 'one-time', 'custom'];
const ALT_TYPES = ['open-source', 'free'];
const ALT_PLATFORMS = ['web', 'macos', 'windows', 'linux', 'ios', 'android', 'self-hosted', 'cli', 'browser-extension'];
const ALT_SELF_HOST = ['hosted', 'one-click', 'docker', 'ops'];
const FACT_RUNS = ['local', 'cloud', 'both', 'self-hosted'];
const TIER_PER = ['user', 'workspace', 'flat'];

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
// The slug is the one field that becomes URLs, file paths (/icons/<slug>.png)
// and DOM attributes, so it gets a format allowlist rather than a character
// blocklist: quotes and event-handler attributes need no angle brackets.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isSlug = (v) => isStr(v) && SLUG_RE.test(v);
const isStrArray = (v) => Array.isArray(v) && v.every((x) => isStr(x));

// Every key every entry carries today. A missing one is a PR that copied an old
// template; the pages read all of them.
const REQUIRED = {
  slug: isSlug,
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
  alternatives: (v) => Array.isArray(v),
  rejectedAlternatives: (v) => Array.isArray(v),
  pagePriority: (v) => typeof v === 'number' && v >= 1 && v <= 5,
  verifiedOneShot: (v) => typeof v === 'boolean',
  notes: (v) => v === null || typeof v === 'string',
  prompt: isStr,
  promptCurated: (v) => typeof v === 'boolean',
};

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const problems = [];

for (const file of files) {
  const bad = (msg) => problems.push(`${file}: ${msg}`);
  let app;
  try {
    app = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    bad(`invalid JSON — ${err.message}`);
    continue;
  }

  // Defense in depth against markup injection: app JSON is rendered into pages,
  // including a JSON-LD <script> block, so no string field may carry the angle
  // brackets that could break out of a tag. Reject "<" and ">" anywhere.
  // `prompt` is exempt: the copy-paste prompts legitimately contain "<"/">"
  // (comparisons, code) and are only ever rendered as escaped text, never into
  // a <script>/JSON-LD block.
  const scanAngles = (val, keyPath) => {
    if (typeof val === 'string') {
      if (val.includes('<') || val.includes('>')) bad(`"${keyPath}" contains "<" or ">" (not allowed in app content)`);
    } else if (Array.isArray(val)) {
      val.forEach((v, i) => scanAngles(v, `${keyPath}[${i}]`));
    } else if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        if (k === 'prompt') continue;
        scanAngles(v, keyPath ? `${keyPath}.${k}` : k);
      }
    }
  };
  scanAngles(app, '');

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
    // Optional: one plain sentence about the free tier (or its absence). When
    // present the page leads with pricing in <title>/meta, so it must be real.
    if (app.pricing.freeTier !== undefined && app.pricing.freeTier !== null && !isStr(app.pricing.freeTier)) {
      bad('pricing.freeTier must be a non-empty string or null');
    }

    // Optional researched tier block: all tiers with numeric caps and billing
    // facts. The fields travel together: a tiers array without the caps and
    // billing lines renders a half-empty pricing section.
    const p = app.pricing;
    if (p.tiers !== undefined) {
      const strOrNull = (v) => v === null || isStr(v);
      const priceOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
      const httpUrl = (v) => isStr(v) && /^https?:\/\//.test(v);
      if (!Array.isArray(p.tiers) || p.tiers.length < 1) bad('pricing.tiers must be a non-empty array');
      else p.tiers.forEach((t, i) => {
        const w = `pricing.tiers[${i}]`;
        if (!t || typeof t !== 'object' || Array.isArray(t)) return bad(`${w} must be an object`);
        if (!isStr(t.name)) bad(`${w}.name is required`);
        if (!priceOrNull(t.monthly)) bad(`${w}.monthly must be a number or null`);
        if (!priceOrNull(t.annualPerMonth)) bad(`${w}.annualPerMonth must be a number or null`);
        if (!TIER_PER.includes(t.per)) bad(`${w}.per must be ${TIER_PER.join(' | ')}`);
        if (!strOrNull(t.limits)) bad(`${w}.limits must be a string or null`);
        if (!strOrNull(t.notes)) bad(`${w}.notes must be a string or null`);
      });
      if (!isStr(p.freeTierCaps)) bad('pricing.freeTierCaps is required alongside pricing.tiers');
      if (!isStr(p.billingTerms)) bad('pricing.billingTerms is required alongside pricing.tiers');
      if (!Array.isArray(p.priceChanges)) bad('pricing.priceChanges must be an array (empty when unsourceable)');
      else p.priceChanges.forEach((c, i) => {
        if (!c || !isStr(c.what) || typeof c.toUsd !== 'number' || !/^\d{4}-\d{2}$/.test(c.when ?? '') || !httpUrl(c.source)) {
          bad(`pricing.priceChanges[${i}] needs what, toUsd, when "YYYY-MM", source URL`);
        }
      });
      if (p.hiddenCosts !== null && !isStr(p.hiddenCosts)) bad('pricing.hiddenCosts must be a string or null');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.tiersCheckedOn ?? '')) bad('pricing.tiersCheckedOn must be "YYYY-MM-DD"');
      if (!Array.isArray(p.tiersSources) || p.tiersSources.length < 1 || !p.tiersSources.every(httpUrl)) {
        bad('pricing.tiersSources must be a non-empty array of URLs');
      }
    }
  }

  // Optional death notice: a sentence fragment that reads as "{name} {discontinued}."
  // ("shut down on September 24, 2025"). The page renders a post-mortem banner
  // and stops claiming a live price when it is present.
  if (app.discontinued !== undefined && app.discontinued !== null && !isStr(app.discontinued)) {
    bad('discontinued must be a non-empty string or null');
  }

  if (Array.isArray(app.priorArt)) {
    app.priorArt.forEach((p, i) => {
      if (!p || typeof p !== 'object' || !isStr(p.name) || !isStr(p.url)) {
        bad(`priorArt[${i}] needs a name and a url`);
      }
    });
  }
  if (app.relatedSlugs !== undefined && !isStrArray(app.relatedSlugs)) {
    bad('relatedSlugs must be an array of slugs');
  }

  if (Array.isArray(app.alternatives)) {
    if (app.alternatives.length > 8) {
      bad(`alternatives is capped at 8 curated entries, found ${app.alternatives.length}`);
    }
    const urls = new Set();
    app.alternatives.forEach((a, i) => {
      const where = `alternatives[${i}]`;
      if (!a || typeof a !== 'object' || Array.isArray(a)) return bad(`${where} must be an object`);
      if (!isStr(a.name)) bad(`${where}.name is required`);
      if (!isStr(a.url) || !/^https?:\/\//.test(a.url)) bad(`${where}.url must be an http(s) URL`);
      if (!ALT_TYPES.includes(a.type)) bad(`${where}.type must be ${ALT_TYPES.join(' | ')}`);
      if (a.type === 'open-source') {
        if (!isStr(a.repo) || !/^https?:\/\//.test(a.repo)) bad(`${where}.repo is required for open-source entries`);
        if (typeof a.stars !== 'number' || a.stars < 0) bad(`${where}.stars is required for open-source entries`);
        if (!/^\d{4}-\d{2}$/.test(a.lastCommit ?? '')) bad(`${where}.lastCommit must be "YYYY-MM" for open-source entries`);
      } else if (a.type === 'free') {
        if (a.repo !== null) bad(`${where}.repo must be null for free entries`);
        if (a.stars !== null) bad(`${where}.stars must be null for free entries`);
        if (a.lastCommit !== null) bad(`${where}.lastCommit must be null for free entries`);
      }
      if (!Array.isArray(a.platforms) || a.platforms.length < 1 || !a.platforms.every((x) => ALT_PLATFORMS.includes(x))) {
        bad(`${where}.platforms needs 1+ of ${ALT_PLATFORMS.join(' | ')}`);
      }
      if (!isStr(a.desc)) bad(`${where}.desc is required`);
      if (!ALT_SELF_HOST.includes(a.selfHost)) bad(`${where}.selfHost must be ${ALT_SELF_HOST.join(' | ')}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.checkedOn ?? '')) bad(`${where}.checkedOn must be "YYYY-MM-DD"`);
      // Optional verified fact block (license/runtime/install/data facts).
      // null inside it is data ("verified none"/"does not apply"), not "unknown":
      // anything unverifiable stays null and claims no source.
      if (a.facts !== undefined) {
        const f = a.facts;
        const fw = `${where}.facts`;
        const strOrNull = (v) => v === null || isStr(v);
        if (!f || typeof f !== 'object' || Array.isArray(f)) bad(`${fw} must be an object`);
        else {
          if (!strOrNull(f.license)) bad(`${fw}.license must be a string (SPDX id or "proprietary-free") or null`);
          if (!FACT_RUNS.includes(f.runs)) bad(`${fw}.runs must be ${FACT_RUNS.join(' | ')}`);
          for (const k of ['install', 'engines', 'dataFormat', 'gapVsPaid', 'setupBlocker']) {
            if (!strOrNull(f[k])) bad(`${fw}.${k} must be a string or null`);
          }
          if (!Array.isArray(f.sources) || f.sources.length < 1 || !f.sources.every((s) => isStr(s) && /^https?:\/\//.test(s))) {
            bad(`${fw}.sources must be a non-empty array of URLs`);
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(f.checkedOn ?? '')) bad(`${fw}.checkedOn must be "YYYY-MM-DD"`);
        }
      }
      if (a.url && urls.has(a.url)) bad(`${where}.url duplicates another entry`);
      urls.add(a.url);
    });
  }

  if (Array.isArray(app.rejectedAlternatives)) {
    if (app.rejectedAlternatives.length > 8) {
      bad(`rejectedAlternatives is capped at 8, found ${app.rejectedAlternatives.length}`);
    }
    app.rejectedAlternatives.forEach((r, i) => {
      if (!r || typeof r !== 'object' || !isStr(r.name) || !isStr(r.desc)) {
        bad(`rejectedAlternatives[${i}] needs a name and a desc (the reason it fails)`);
      } else if (r.url !== null && !(isStr(r.url) && /^https?:\/\//.test(r.url))) {
        bad(`rejectedAlternatives[${i}].url must be an http(s) URL or null`);
      }
    });
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s) in ${files.length} app files:\n`);
  problems.forEach((p) => console.error(`  ${p}`));
  process.exit(1);
}

console.log(`✓ ${files.length} app files pass`);
