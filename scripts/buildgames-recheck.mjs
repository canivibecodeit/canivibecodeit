/* Daily Safe Browsing recheck of live/held Build Games sponsor links. A link
   that screened clean at bid time can be weaponised later; this re-screens the
   stored final URL and HOLDS any live sponsor that now matches — the paid
   equivalent of the challenge recheck, and the backstop H3 requires.

   Fail-closed, tighten-only: a positive match holds; an API outage NEVER
   stamps 'clean' and never un-holds. Every checked sponsor gets
   last_checked_at / check_result. Removed sponsors are left alone (their money
   stays in the pot; they're already off the board).

   Idempotent + run-anywhere (Railway cron via DATABASE_URL, VPS via
   DATABASE_PUBLIC_URL, mirror via --sqlite). Modes: --dry, --sqlite.
   Config from the environment: GOOGLE_SAFEBROWSING_KEY, DATABASE_URL /
   DATABASE_PUBLIC_URL, RESEND_*. Key unset = no-op that says so. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const USE_SQLITE = process.argv.includes('--sqlite');

try {
  for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env — cron has the real environment */
}

if (USE_SQLITE) delete process.env.DATABASE_URL;
else if (!process.env.DATABASE_URL && process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { bgSponsorsForRecheck, updateBgSponsor } = await import('../src/lib/db.js');
const { checkUrls, safeBrowsingOn } = await import('../src/lib/safe-browsing.js');
const { alertAdmin, esc } = await import('../src/lib/mail.js');
const { sendSponsorMail } = await import('../src/lib/buildgames-mail.js');
const { displayName } = await import('../src/lib/buildgames.js');

if (!safeBrowsingOn()) {
  console.log('buildgames-recheck: GOOGLE_SAFEBROWSING_KEY unset — nothing to check against, exiting clean.');
  process.exit(0);
}

const sponsors = await bgSponsorsForRecheck();
if (sponsors.length === 0) {
  console.log('buildgames-recheck: no live or held sponsors. done.');
  process.exit(0);
}
console.log(`buildgames-recheck: ${sponsors.length} sponsors (${DRY ? 'DRY RUN' : 'live'})`);

// Batch through Safe Browsing (500/request). apiHealthy gates the clean-stamp.
const links = sponsors.map((s) => s.link);
const matches = new Map();
let apiHealthy = true;
for (let i = 0; i < links.length; i += 500) {
  const { ok, matches: chunk } = await checkUrls(links.slice(i, i + 500));
  if (!ok) { apiHealthy = false; continue; }
  for (const [u, threats] of chunk) matches.set(u, threats);
}

const now = Date.now();
const newlyHeld = [];
for (const s of sponsors) {
  const threats = matches.get(s.link) ?? null;
  if (threats && s.status === 'active') {
    newlyHeld.push({ s, threats });
    console.log(`  HOLD ${s.id} ${s.link} → ${threats.join(', ')}`);
    if (!DRY) {
      await updateBgSponsor(s.id, {
        status: 'held',
        held_reason: `safe-browsing (recheck): ${threats.join(', ')}`,
        last_checked_at: now,
        check_result: `match: ${threats.join(', ')}`,
      });
      if (s.contact_email) {
        // Suppression + per-address caps live inside sendSponsorMail (E1).
        await sendSponsorMail({
          to: s.contact_email,
          subject: 'Your Build Games placement is under review',
          html: `<p>Your placement (<b>${esc(displayName(s))}</b>) was flagged by Safe Browsing and is temporarily held. Your contribution stays in the prize pool.</p>`,
        }).catch((err) => console.error(`recheck held mail failed: ${err.message}`));
      }
    }
  } else if (threats) {
    if (!DRY) await updateBgSponsor(s.id, { last_checked_at: now, check_result: `match: ${threats.join(', ')}` });
  } else if (apiHealthy && !DRY) {
    await updateBgSponsor(s.id, { last_checked_at: now, check_result: 'clean' });
  }
}

if (!apiHealthy) {
  console.log('buildgames-recheck: WARNING — Safe Browsing API unhealthy this run; clean stamps skipped, only matches held.');
}
if (newlyHeld.length > 0 && !DRY) {
  const rows = newlyHeld
    .map(({ s, threats }) => `<li><b>${esc(displayName(s))}</b> (${esc(s.link)}) · ${esc(threats.join(', '))}</li>`)
    .join('');
  await alertAdmin(
    `[cvci] build games recheck held ${newlyHeld.length}`,
    `<p>The Safe Browsing recheck pulled these off the board (money stays in the pool):</p><ul>${rows}</ul>
     <p><a href="https://vibecodeit.com/admin/thebuildgames">open the queue and paste your token</a></p>`
  ).catch((err) => console.error(`recheck alert failed: ${err.message}`));
}

console.log(`buildgames-recheck: done · ${sponsors.length} checked · ${newlyHeld.length} newly held · ${matches.size} matches`);
process.exit(0);
