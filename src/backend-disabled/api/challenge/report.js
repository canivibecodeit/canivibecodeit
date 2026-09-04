// Report a challenge entry. A report is a signal, not a takedown button: it
// takes HOLD_AT DISTINCT reporters (deduped per IP+entry per day) to auto-hold
// an entry, so one person with a script can't censor a rival — the audit's
// report-bombing hole (H2). Crossing the threshold pings Faizan once.
import { createHash } from 'node:crypto';
import { addEntryReport, challengeEntryById, rateLimit, updateChallengeEntry } from '../../../lib/db.js';
import { challengeLive } from '../../../lib/flags.js';
import { alertAdmin, esc } from '../../../lib/mail.js';
import { clientIp, crossOrigin, json, readBody } from '../../../lib/request.js';
import { ENTRY_ID_RE } from '../../../lib/challenge.js';

const HOLD_AT = 5; // distinct reporters

// A STABLE server-side salt: the per-(entry, reporter) dedupe must hold for
// the whole challenge window, not reset at each UTC midnight — otherwise one
// IP earns a fresh "distinct" identity every day and can auto-hold a rival
// across five calendar days inside a seven-day window (audit N2). Any set
// server secret works as the pepper; it only needs to be stable and private.
const REPORT_SALT =
  process.env.SPONSOR_SIGNING_SECRET || process.env.BETTER_AUTH_SECRET || process.env.ADMIN_TOKEN || 'cvci-challenge-reports';

export async function POST({ request, clientAddress }) {
  if (!challengeLive()) return new Response(null, { status: 404 });
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`chrep:${ip}`, 10, 60 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const id = String(body.id ?? '');
  if (!ENTRY_ID_RE.test(id)) return json({ error: 'bad id' }, 400);

  const reporterHash = createHash('sha256').update(`${REPORT_SALT}:${id}:${ip}`).digest('hex').slice(0, 32);
  const distinct = await addEntryReport(id, reporterHash);

  // Duplicate report from this reporter, or unknown entry: nothing moves, but
  // the response is identical so a reporter can't probe entry existence.
  if (distinct == null) return json({ ok: true });

  // Threshold crossing exactly once: '===' keeps later distinct reports from
  // re-holding an entry an admin already looked at and relisted.
  if (distinct === HOLD_AT) {
    const entry = await challengeEntryById(id);
    if (entry && entry.status === 'live') {
      await updateChallengeEntry(id, { status: 'held', held_reason: `reports: ${distinct} distinct` });
      alertAdmin(
        '[cvci] challenge entry auto-held on reports',
        `<p><b>${esc(entry.page_title ?? entry.url)}</b> by @${esc(entry.x_handle)} hit ${distinct} distinct reports and is out of the gallery pending a look.</p>
         <p><a href="https://vibecodeit.com/admin/challenge">open the queue and paste your token</a></p>`
      ).catch((err) => console.error(`challenge report alert failed: ${err.message}`));
    }
  }

  return json({ ok: true });
}
