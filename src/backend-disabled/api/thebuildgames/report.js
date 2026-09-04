// Report a Build Games sponsor. On a PAID board a flat "5 reports = delisted"
// hands a competitor the #1 spot for the cost of one VPN (audit H5), so the
// response scales with what the placement is worth:
//   - reports are deduped per distinct reporter (stable salt);
//   - a HIGH-VALUE placement (cleared ≥ PAID_ALERT) is NEVER auto-held on
//     reports — it only ever alerts Faizan for a human decision;
//   - a low-value one auto-holds, but only past a threshold that SCALES with
//     the amount paid AND only when the reports are SPREAD OVER TIME (a burst
//     from one actor in minutes alerts instead of holding).
// The sponsor's cleared money always stays in the pot; only the placement is
// affected.
import { createHash } from 'node:crypto';
import {
  addBgReport,
  bgFirstReportAt,
  bgSponsorById,
  bgSponsorClearedTotal,
  rateLimit,
  updateBgSponsor,
} from '../../../lib/db.js';
import { buildGamesLive } from '../../../lib/flags.js';
import { alertAdmin, esc } from '../../../lib/mail.js';
import { sendSponsorMail } from '../../../lib/buildgames-mail.js';
import { clientIp, crossOrigin, json, readBody } from '../../../lib/request.js';
import { SPONSOR_ID_RE, displayName } from '../../../lib/buildgames.js';

const REPORT_SALT =
  process.env.SPONSOR_SIGNING_SECRET || process.env.BETTER_AUTH_SECRET || process.env.ADMIN_TOKEN || 'cvci-buildgames-reports';

const PAID_ALERT_CENTS = 100000; // ≥ $1000 cleared → human-only, never auto-held
const MIN_SPREAD_MS = 60 * 60 * 1000; // reports must span ≥ 1h to auto-hold
const BASE_HOLD = 5; // distinct reporters at $0
// +1 required reporter per $50 cleared, capped — so a $15k placement needs far
// more signal than a $5 one before an auto-hold is even considered.
const requiredReporters = (clearedCents) => Math.min(40, BASE_HOLD + Math.floor(clearedCents / 5000));

export async function POST({ request, clientAddress }) {
  if (!buildGamesLive()) return new Response(null, { status: 404 });
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`bgrep:${ip}`, 10, 60 * 60 * 1000))) return json({ error: 'slow down' }, 429);

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  const id = String(body.id ?? '');
  if (!SPONSOR_ID_RE.test(id)) return json({ error: 'bad id' }, 400);

  const reporterHash = createHash('sha256').update(`${REPORT_SALT}:${id}:${ip}`).digest('hex').slice(0, 32);
  const distinct = await addBgReport(id, reporterHash);
  if (distinct == null) return json({ ok: true }); // dup or unknown — neutral

  const s = await bgSponsorById(id);
  if (!s || s.status !== 'active') return json({ ok: true });

  const cleared = await bgSponsorClearedTotal(id);
  const alertReview = (why) =>
    alertAdmin(
      '[cvci] build games sponsor reported — needs a look',
      `<p><b>${esc(displayName(s))}</b> (${esc(s.link)}, $${Math.round(cleared / 100)} cleared) — ${why} (${distinct} distinct reports). Placement left LIVE for you to judge.</p>
       <p><a href="https://vibecodeit.com/admin/thebuildgames">open the queue and paste your token</a></p>`
    ).catch((err) => console.error(`bg report alert failed: ${err.message}`));

  // High-value placement: never auto-hold on anonymous reports; alert once so a
  // human decides. A brigade can't delist a paid #1 spot.
  if (cleared >= PAID_ALERT_CENTS) {
    if (distinct === 3) alertReview('high-value placement, reports coming in');
    return json({ ok: true });
  }

  // Low-value: auto-hold only past a scaled threshold AND only if the reports
  // are spread over time (a burst alerts instead, so one VPN toggling in
  // minutes can't trigger it).
  const need = requiredReporters(cleared);
  if (distinct >= need) {
    const firstAt = await bgFirstReportAt(id);
    if (firstAt != null && Date.now() - firstAt >= MIN_SPREAD_MS) {
      await updateBgSponsor(id, { status: 'held', held_reason: `reports: ${distinct} distinct over ${Math.round((Date.now() - firstAt) / 3600000)}h` });
      alertAdmin(
        '[cvci] build games sponsor auto-held on reports',
        `<p><b>${esc(displayName(s))}</b> (${esc(s.link)}) hit ${distinct} distinct reports spread over time and is off the board pending a look. Its cleared money stays in the pool.</p>
         <p><a href="https://vibecodeit.com/admin/thebuildgames">open the queue and paste your token</a></p>`
      ).catch((err) => console.error(`bg report alert failed: ${err.message}`));
      // Tell the sponsor their placement was held (if they left an email).
      // Suppression + per-address caps live inside sendSponsorMail (E1).
      if (s.contact_email) {
        sendSponsorMail({
          to: s.contact_email,
          subject: 'Your Build Games placement is under review',
          html: `<p>Your placement (<b>${esc(displayName(s))}</b>) has been temporarily held after community reports and is being reviewed.</p>
                 <p>Your contribution stays in the sponsorship pool. We'll be in touch if anything's needed.</p>`,
        }).catch((err) => console.error(`held mail failed: ${err.message}`));
      }
    } else if (distinct === need) {
      alertReview('report threshold hit as a BURST — possible brigade, not auto-held');
    }
  }
  return json({ ok: true });
}
