// Build Games admin (token-gated). The launch funding path — Faizan adds a
// sponsor + clears its payment by hand — plus moderation. Same admin-gate
// pattern as the sponsor board. Form posts bounce back to /admin/thebuildgames.
import {
  bgBlockHost,
  bgPaymentById,
  bgSponsorById,
  bgUnblockHost,
  insertBgPayment,
  rateLimit,
  updateBgSponsor,
} from '../../../lib/db.js';
import { alertAdmin } from '../../../lib/mail.js';
import { clientIp, crossOrigin, json, readBody } from '../../../lib/request.js';
import { isAdmin } from '../../../lib/sponsors.js';
import { assertSafeBrowsingReady } from '../../../lib/safe-browsing.js';
import {
  MAX_BID_CENTS,
  MIN_ENTRY_CENTS,
  MIN_TOPUP_CENTS,
  PAYMENT_ID_RE,
  SPONSOR_ID_RE,
  TAGLINE_MAX,
  cleanTagline,
  newPaymentId,
  registrableHost,
} from '../../../lib/buildgames.js';
import { screenSubmission } from '../../../lib/buildgames-screen.js';
import { clearPayment, reversePayment, submitBid } from '../../../lib/buildgames-payments.js';

export async function POST({ request, clientAddress, cookies }) {
  // Same-origin only, and never accept the malware gate being unarmed on an
  // endpoint that moves the pot (H1: admin path must assert too).
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);
  assertSafeBrowsingReady();

  const wantsJson = (request.headers.get('content-type') || '').includes('application/json');

  // Rate-limit + alert on this financial endpoint (M2): 10 attempts / 15 min /
  // IP, and a one-shot alert when that trips, so token-guessing can't run
  // unlimited and unlogged against the pot/leaderboard mutators.
  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`bgadmin:${ip}`, 10, 15 * 60 * 1000))) {
    if (await rateLimit('bgadmin:alert', 1, 60 * 60 * 1000)) {
      alertAdmin(
        '[cvci] build games admin rate limit tripped',
        `<p>10+ admin POSTs from one IP in 15 min — possible token guessing against the Build Games admin. IP hash withheld; check logs.</p>`
      ).catch((err) => console.error(`bgadmin alert failed: ${err.message}`));
    }
    return json({ error: 'slow down' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  // Token comes from the HttpOnly cookie the console set (M3 — keeps it out of
  // the URL/logs), or the request BODY for JSON/programmatic callers. Never
  // from the query string.
  const token = cookies?.get('bg_admin')?.value || body.token;
  if (!isAdmin(token)) return json({ error: 'not found' }, 404);

  // return_to carries NO token now (cookie holds it); bounce to the bare path.
  const backTo = (message) => {
    const back = String(body.return_to || '');
    const target = /^\/(?![/\\])/.test(back) ? back.split('?')[0] : '/thebuildgames';
    return new Response(null, {
      status: 303,
      headers: { Location: `${target}?msg=${encodeURIComponent(message)}` },
    });
  };
  const done = (m) => (wantsJson ? json({ ok: true, message: m }) : backTo(m));
  const fail = (e, s) => (wantsJson ? json({ error: e }, s) : backTo(e));

  // Admin forms post whole dollars; the interface works in cents.
  const centsFromBody = () => {
    if (body.amount_cents != null) return Math.round(Number(body.amount_cents));
    if (body.amount_dollars != null) return Math.round(Number(body.amount_dollars) * 100);
    return NaN;
  };

  const action = String(body.action ?? '');

  // Add a sponsor + a CLEARED payment in one step (manual funding). Screens the
  // link exactly like the public path, then clears immediately.
  if (action === 'add') {
    const amountCents = centsFromBody();
    if (!Number.isInteger(amountCents) || amountCents < MIN_ENTRY_CENTS || amountCents > MAX_BID_CENTS) {
      return fail(`amount $${MIN_ENTRY_CENTS / 100}–$${MAX_BID_CENTS / 100}`, 400);
    }
    const tagline = cleanTagline(body.tagline);
    const screen = await screenSubmission(body.link);
    if (!screen.ok) return fail(screen.reason || 'bad link', 400);
    const res = await submitBid({ screen, tagline, amountCents });
    if (res.error) return fail('that site is blocked', 403);
    // clearPayment freezes the sponsor's status from THIS payment's screen —
    // clean → active, flagged/held/unknown → held. So the Safe Browsing verdict
    // is honoured automatically on the (only) dark-ship funding path; we just
    // tell the operator which way it went.
    await clearPayment(res.paymentId);
    return screen.verdict === 'ok'
      ? done(`added · $${amountCents / 100}`)
      : done(`HELD · ${screen.reason || 'Safe Browsing flagged this link'} — review in the queue, it is not listed`);
  }

  // Top up an existing sponsor with a cleared payment.
  if (action === 'topup') {
    const id = String(body.id ?? '');
    if (!SPONSOR_ID_RE.test(id)) return fail('bad id', 400);
    const sponsor = await bgSponsorById(id);
    if (!sponsor) return fail('unknown sponsor', 404);
    // N2: a top-up payment carries NO screening result. If it were this
    // sponsor's FIRST clear it would win the one-shot identity claim with a
    // blank tagline and 'held' status — permanently, with the money counted
    // and the placement unrecoverable. Refuse: fund an unclaimed sponsor by
    // clearing its pending bid (`clear`), or via `add`, both of which carry a
    // screen. This button sits next to those in the console; make the wrong
    // one impossible, not discouraged.
    if (sponsor.first_cleared_at == null) {
      return fail('this sponsor has no cleared payment yet — clear its pending bid (or use add); a top-up here would spend the identity claim blank', 409);
    }
    const amountCents = centsFromBody();
    if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_BID_CENTS) {
      return fail('bad amount', 400);
    }
    const pid = newPaymentId();
    // Ref is unique per payment (processor_ref carries a unique index now).
    await insertBgPayment({ id: pid, sponsor_id: id, amount_cents: amountCents, status: 'pending', processor_ref: `admin:${pid}`, created_at: Date.now() });
    await clearPayment(pid);
    return done(`topped up · $${amountCents / 100}`);
  }

  // Payment lifecycle (for a real processor / corrections).
  if (action === 'clear' || action === 'reverse') {
    const pid = String(body.payment_id ?? '');
    if (!PAYMENT_ID_RE.test(pid)) return fail('bad payment id', 400);
    const ok = action === 'clear' ? await clearPayment(pid) : await reversePayment(pid);
    return ok ? done(`${action} · done`) : fail('no change', 400);
  }

  // Sponsor moderation.
  const id = String(body.id ?? '');
  if (!SPONSOR_ID_RE.test(id)) return fail('bad id', 400);
  const sponsor = await bgSponsorById(id);
  if (!sponsor) return fail('unknown sponsor', 404);
  const host = () => registrableHost(new URL(sponsor.link).hostname);

  if (action === 'release') {
    await updateBgSponsor(id, { status: 'active', held_reason: null });
    return done('released');
  }
  if (action === 'remove') {
    // Removed for abuse: placement forfeited, cleared money STAYS in the pool.
    await updateBgSponsor(id, { status: 'removed' });
    try { await bgBlockHost(host(), 'admin remove', Date.now()); } catch { /* unparseable link */ }
    return done('removed · money stays in pool');
  }
  if (action === 'restore') {
    await updateBgSponsor(id, { status: 'active', held_reason: null });
    try { await bgUnblockHost(host()); } catch { /* noop */ }
    return done('restored');
  }
  if (action === 'edit-tagline') {
    const tagline = cleanTagline(body.tagline);
    if (body.tagline && !tagline) return fail(`tagline: up to ${TAGLINE_MAX} chars, no links`, 400);
    await updateBgSponsor(id, { tagline: tagline ?? null });
    return done('tagline updated');
  }

  return fail('unknown action', 400);
}
