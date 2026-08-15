/* Nightly pageview export: pulls per-day aggregates out of PostHog and appends
   them to plain-text files outside the repo, because PostHog's free tier only
   guarantees a year of history and traffic data is worth keeping forever.

   Two append-only TSVs, complete UTC days only (yesterday and older):
     pageviews.tsv   day  path  views  visitors
     referrers.tsv   day  referring-domain  views   ('$direct' = typed/bookmark)

   State: .last-day remembers the newest fully exported day; every run exports
   the days after it, so a missed night self-heals on the next run and nothing
   is appended twice. State only advances after a successful append.

   Config from the environment (real env wins over the local .env file):
   POSTHOG_PROJECT_ID, POSTHOG_PERSONAL_KEY, POSTHOG_UI_HOST. Read-only API
   access, one query per file per run, far under PostHog's rate limits. */

import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.PAGEVIEW_STATE_DIR || '/srv/http/canivibecodeit-data/pageviews';
const STATE_FILE = path.join(STATE_DIR, '.last-day');
// Nothing exists before the site did; the first run backfills from here.
const FLOOR_DAY = '2026-07-25';

function loadEnvFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = (value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in the environment`);
  return v;
}

loadEnvFile(path.join(root, '.env'));
const HOST = process.env.POSTHOG_UI_HOST || 'https://eu.posthog.com';
const PROJECT = need('POSTHOG_PROJECT_ID');
const KEY = need('POSTHOG_PERSONAL_KEY');

async function hogql(query) {
  const res = await fetch(`${HOST}/api/projects/${PROJECT}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, refresh: 'blocking' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`posthog ${res.status}`);
  return (await res.json()).results ?? [];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const utcDay = (d) => d.toISOString().slice(0, 10);
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);

function lastExportedDay() {
  try {
    const d = readFileSync(STATE_FILE, 'utf8').trim();
    return DAY_RE.test(d) ? d : null;
  } catch {
    return null;
  }
}

mkdirSync(STATE_DIR, { recursive: true });

const last = lastExportedDay();
// Day strings compare correctly as strings; from = the day after `last`.
const from = last
  ? utcDay(new Date(Date.parse(last) + 24 * 60 * 60 * 1000))
  : FLOOR_DAY;
const to = utcDay(new Date(Date.now() - 24 * 60 * 60 * 1000)); // yesterday: complete
if (!DAY_RE.test(from) || from > to) {
  console.log(`${new Date().toISOString()} nothing to export (through ${last})`);
  process.exit(0);
}

/* One day per pair of queries, oldest first, state advanced after each day:
   a failure mid-backfill keeps everything already appended and resumes from
   the failed day next run. HogQL silently caps un-LIMITed queries at 100
   rows, so the LIMIT is explicit and hitting it is treated as an error
   rather than a quietly incomplete export. */
const LIMIT = 50000;

function dayFilter(day) {
  return `
    AND properties.$host = 'canivibecodeit.com'
    AND toDate(timestamp) = toDate('${day}')
  `;
}

const tsv = (rows) =>
  rows.map((r) => r.map((v, i) => (i === 0 ? String(v).slice(0, 10) : clean(v))).join('\t')).join('\n');

try {
  let day = from;
  let totalPages = 0;
  let totalRefs = 0;
  while (day <= to) {
    const views = await hogql(`
      SELECT toDate(timestamp) AS day, properties.$pathname AS path,
             count() AS views, count(DISTINCT distinct_id) AS visitors
      FROM events
      WHERE event = '$pageview' ${dayFilter(day)}
      GROUP BY day, path
      ORDER BY path
      LIMIT ${LIMIT}
    `);
    const refs = await hogql(`
      SELECT toDate(timestamp) AS day, properties.$referring_domain AS ref, count() AS views
      FROM events
      WHERE event = '$pageview' ${dayFilter(day)}
      GROUP BY day, ref
      ORDER BY views DESC
      LIMIT ${LIMIT}
    `);
    if (views.length >= LIMIT || refs.length >= LIMIT) {
      throw new Error(`${day} hit the ${LIMIT}-row limit, refusing to export it incomplete`);
    }
    if (views.length) appendFileSync(path.join(STATE_DIR, 'pageviews.tsv'), tsv(views) + '\n');
    if (refs.length) appendFileSync(path.join(STATE_DIR, 'referrers.tsv'), tsv(refs) + '\n');
    writeFileSync(STATE_FILE, day);
    totalPages += views.length;
    totalRefs += refs.length;
    day = utcDay(new Date(Date.parse(day) + 24 * 60 * 60 * 1000));
  }
  console.log(
    `${new Date().toISOString()} exported ${from}..${to}: ${totalPages} page rows, ${totalRefs} referrer rows`
  );
} catch (err) {
  console.error(`${new Date().toISOString()} export failed:`, err.message);
  process.exitCode = 1;
}
