/* One-time-ish importer: merges the research seed sheet (scripts/seed-apps.json,
   exported from the source spreadsheet) with any hand-curated app JSONs already in
   data/apps/. Hand-written prompts and prior art always win over generated ones.
   Also snapshots the full seed into the `apps_seed` table of the runtime DB. */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsDir = path.join(root, 'data/apps');
const seed = JSON.parse(readFileSync(path.join(root, 'scripts/seed-apps.json'), 'utf8'));

// Existing hand-curated files (prompts are the crown jewels — never clobber).
const hand = {};
for (const f of readdirSync(appsDir).filter((f) => f.endsWith('.json'))) {
  const a = JSON.parse(readFileSync(path.join(appsDir, f), 'utf8'));
  hand[a.slug] = a;
}

// My original taxonomy → sheet taxonomy, so one system remains.
const CAT_REMAP = {
  'site-builders': 'website-builder',
  social: 'social-media',
  dictation: 'voice-dictation',
};

const splitList = (s) =>
  (s || '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);

const toNumber = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function generatedPrompt(a) {
  if (a.verdict === 'no') return null;
  const reqs = splitList(a.requirements).map((r) => `- Needs: ${r}.`);
  const lose = splitList(a.whatYouLose).slice(0, 3).join('; ');
  return [
    `Build me a personal replacement for ${a.name} (${a.tagline?.replace(/\.$/, '') || a.subcategory}). Requirements:`,
    '',
    `- Core loop: ${a.coreLoopDIY}`,
    ...reqs,
    '- Keep it personal-scale: no accounts, no telemetry, secrets in .env, SQLite or',
    '  flat files for storage. Local-first wherever possible.',
    '- Clean minimal UI where one is needed; CLI is fine where one is not.',
    '- Include a README with setup steps, required keys, and any OS permissions.',
    '',
    `Honest scope: this covers the core loop only. You will not get: ${lose}.`,
  ].join('\n');
}

function fromSeed(s) {
  const h = hand[s.slug];
  const domain = (s.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const priorArt =
    h?.priorArt?.length
      ? h.priorArt
      : s.priorArtName
        ? [{ name: s.priorArtName, url: s.priorArtURL, desc: s.priorArtNote?.slice(0, 90) || '', status: s.priorArtStatus }]
        : [];

  return {
    slug: s.slug,
    name: s.name,
    domain,
    category: CAT_REMAP[s.category] || s.category,
    subcategory: s.subcategory || null,
    tagline: s.tagline || null,
    priceMonthly: toNumber(s.monthlyUSD),
    pricing: {
      plan: s.pricingPlan || null,
      basis: s.billingBasis || null,
      native: s.priceNativeAmount ? `${s.priceNativeAmount} ${s.priceNativeCurrency || ''}`.trim() : null,
      source: (s.pricingSource || '').split('|')[0].trim() || null,
      checkedOn: s.pricingCheckedOn || null,
      confidence: s.priceConfidence || null,
      notes: s.pricingNotes || null,
    },
    verdict: s.verdict,
    verdictConfidence: s.verdictConfidence || null,
    verdictSummary: s.verdictSummary || null,
    coreLoopDIY: s.coreLoopDIY || null,
    diyTimeEstimate: s.diyTimeEstimate || null,
    requirements: splitList(s.requirements),
    whatYouLose: h?.whatYouLose?.length ? h.whatYouLose : splitList(s.whatYouLose),
    moatType: s.moatType || null,
    whyPeopleStillPay: s.whyPeopleStillPay || null,
    priorArt,
    relatedSlugs: (s.relatedSlugs || '').split(',').map((x) => x.trim()).filter(Boolean),
    pagePriority: Number(s.pagePriority) || 3,
    verifiedOneShot: Boolean(s.verifiedOneShot),
    notes: h?.notes || s.selectionRationale || null,
    prompt: h?.prompt ?? generatedPrompt(s),
    promptCurated: Boolean(h?.prompt),
  };
}

// Upgrade a hand-only app (not in the sheet) to the extended schema.
function fromHand(h) {
  return {
    subcategory: null,
    tagline: h.notes?.split('.')[0] || null,
    pricing: { plan: null, basis: 'monthly', native: null, source: null, checkedOn: '2026-07-29', confidence: 'medium', notes: null },
    verdictConfidence: 'high',
    verdictSummary: h.notes || null,
    coreLoopDIY: null,
    diyTimeEstimate: h.verdict === 'yes' ? 'one sitting' : h.verdict === 'kinda' ? 'multi-day' : null,
    requirements: [],
    moatType: null,
    whyPeopleStillPay: null,
    relatedSlugs: [],
    pagePriority: 5,
    verifiedOneShot: false,
    promptCurated: Boolean(h.prompt),
    ...h,
    category: CAT_REMAP[h.category] || h.category,
  };
}

const seedSlugs = new Set(seed.map((s) => s.slug));
const merged = [
  ...seed.map(fromSeed),
  ...Object.values(hand)
    .filter((h) => !seedSlugs.has(h.slug))
    .map(fromHand),
];

for (const app of merged) {
  writeFileSync(path.join(appsDir, `${app.slug}.json`), JSON.stringify(app, null, 2) + '\n');
}
console.log(`wrote ${merged.length} app files (${merged.filter((a) => a.promptCurated).length} curated prompts)`);

// Snapshot the raw sheet into the runtime DB for querying/reference.
const dataDir = process.env.DATA_DIR || path.join(root, 'data/private');
mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'site.db'));
db.exec('DROP TABLE IF EXISTS apps_seed');
const cols = Object.keys(seed[0]);
db.exec(`CREATE TABLE apps_seed (${cols.map((c) => `"${c}" TEXT`).join(', ')})`);
const ins = db.prepare(`INSERT INTO apps_seed VALUES (${cols.map(() => '?').join(',')})`);
const tx = db.transaction(() => {
  for (const s of seed) ins.run(cols.map((c) => (s[c] === null || s[c] === undefined ? null : String(s[c]))));
});
tx();
console.log(`apps_seed snapshot: ${seed.length} rows in ${path.join(dataDir, 'site.db')}`);
