/* Daily challenge-entry recheck: every live and held entry's URL goes back
   through Google Safe Browsing in one batch. A live entry that now matches
   is held (and Faizan pinged once per run); a held entry that comes back clean
   STAYS held — release is a human decision, this job only ever tightens.
   Every checked entry gets last_checked_at/check_result stamped.

   Idempotent and run-anywhere by design: point it at any of the three homes
   (Railway cron via DATABASE_URL, the VPS via DATABASE_PUBLIC_URL, the
   mirror via --sqlite + DATA_DIR) and a re-run changes nothing new.

   Modes:
     --dry      report what would happen, change nothing, send nothing
     --sqlite   use the local sqlite database (DATA_DIR) instead of Postgres

   Config from the environment (real env wins over the local .env file):
   GOOGLE_SAFEBROWSING_KEY, DATABASE_URL or DATABASE_PUBLIC_URL, RESEND_*.
   Key unset = the run is a no-op that says so. Nothing secret lives here. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const USE_SQLITE = process.argv.includes('--sqlite');

// .env fills the gaps; anything already in the real environment wins.
try {
  for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  /* no .env is fine — Railway cron has the real environment */
}

// One data layer, three homes: src/lib/db.js picks Postgres when
// DATABASE_URL is set, sqlite otherwise. Map the outside-in URL onto it.
if (USE_SQLITE) {
  delete process.env.DATABASE_URL;
} else if (!process.env.DATABASE_URL && process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const { challengeEntriesForCheck, updateChallengeEntry } = await import('../src/lib/db.js');
const { checkUrls, safeBrowsingOn } = await import('../src/lib/safe-browsing.js');
const { alertAdmin, esc } = await import('../src/lib/mail.js');

if (!safeBrowsingOn()) {
  console.log('challenge-recheck: GOOGLE_SAFEBROWSING_KEY unset — nothing to check against, exiting clean.');
  process.exit(0);
}

const entries = await challengeEntriesForCheck();
if (entries.length === 0) {
  console.log('challenge-recheck: no live or held entries. done.');
  process.exit(0);
}

console.log(`challenge-recheck: ${entries.length} entries (${DRY ? 'DRY RUN' : 'live'})`);

// One batched lookup (the API takes 500 per request; a bigger gallery gets
// chunked). If ANY chunk comes back not-ok (API error/timeout), this run is
// inconclusive — it only ever TIGHTENS (holds fresh matches) and never
// stamps 'clean', so an outage can't launder a payload to clean the way the
// old fail-open recheck could (audit H3).
const urls = entries.map((e) => e.url);
const matches = new Map();
let apiHealthy = true;
for (let i = 0; i < urls.length; i += 500) {
  const { ok, matches: chunk } = await checkUrls(urls.slice(i, i + 500));
  if (!ok) { apiHealthy = false; continue; }
  for (const [u, threats] of chunk) matches.set(u, threats);
}

const now = Date.now();
const newlyHeld = [];

for (const e of entries) {
  const threats = matches.get(e.url) ?? null;

  if (threats && e.status === 'live') {
    newlyHeld.push({ entry: e, threats });
    console.log(`  HOLD  ${e.id} @${e.x_handle} ${e.url} → match: ${threats.join(', ')}`);
    if (!DRY) {
      await updateChallengeEntry(e.id, {
        status: 'held',
        held_reason: `safe-browsing (recheck): ${threats.join(', ')}`,
        last_checked_at: now,
        check_result: `match: ${threats.join(', ')}`,
      });
    }
  } else if (threats) {
    console.log(`  still-held ${e.id} → match: ${threats.join(', ')}`);
    if (!DRY) await updateChallengeEntry(e.id, { last_checked_at: now, check_result: `match: ${threats.join(', ')}` });
  } else if (apiHealthy && !DRY) {
    // Only stamp 'clean' when the API actually answered for this batch.
    await updateChallengeEntry(e.id, { last_checked_at: now, check_result: 'clean' });
  }
}

if (!apiHealthy) {
  console.log('challenge-recheck: WARNING — Safe Browsing API was unhealthy this run; clean stamps skipped, only matches held.');
}

if (newlyHeld.length > 0 && !DRY) {
  const rows = newlyHeld
    .map(({ entry, threats }) => `<li><b>${esc(entry.page_title ?? entry.url)}</b> by @${esc(entry.x_handle)} · ${esc(threats.join(', '))}</li>`)
    .join('');
  await alertAdmin(
    `[cvci] challenge recheck held ${newlyHeld.length} ${newlyHeld.length === 1 ? 'entry' : 'entries'}`,
    `<p>The daily Safe Browsing recheck pulled these out of the gallery:</p><ul>${rows}</ul>
     <p><a href="https://vibecodeit.com/admin/challenge">open the queue and paste your token</a></p>`
  ).catch((err) => console.error(`recheck alert failed: ${err.message}`));
}

console.log(
  `challenge-recheck: done · ${entries.length} checked · ${newlyHeld.length} newly held · ${matches.size} total matches`
);
process.exit(0);
