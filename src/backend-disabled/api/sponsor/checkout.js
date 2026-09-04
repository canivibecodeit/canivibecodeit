import crypto from 'node:crypto';
import {
  activePurchases, insertPurchase, rateLimit, sponsorSlots, updatePurchase,
} from '../../../lib/db.js';
import { clientIp, json, readBody } from '../../../lib/request.js';
// No clearCache here: holds never appear on the board, so creating or expiring
// one cannot change what the rails render.
import {
  blocksSlot, HOLD_TTL_MS, newToken, nextRunStart, QUARTER_MIN_CENTS, QUARTER_MONTHS,
  RUN_MS, SESSION_TTL_MS, shortDate, siteUrl, SLOT_IDS, SPILL_MS,
} from '../../../lib/sponsors.js';
import { createCheckoutSession } from '../../../lib/stripe.js';

const TAKEN = 'that slot just went';

export async function POST({ request, clientAddress }) {
  const ip = clientIp(request, clientAddress);
  const wantsJson = (request.headers.get('content-type') || '').includes('application/json');
  /* Generous on purpose: clicking through to checkout out of curiosity is
     normal and costs nobody a slot. All this bounds now is Stripe session spam. */
  if (!(await rateLimit(`sponsor-checkout:${ip}`, 20, 60 * 60 * 1000))) {
    return fail(wantsJson, 'slow down', 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return fail(wantsJson, 'bad request', 400);
  }

  const slotId = String(body.slot ?? '').trim().toUpperCase();
  if (!SLOT_IDS.includes(slotId)) return fail(wantsJson, 'unknown slot', 400);
  // A slot's next run is a single 30-day term, bought one click at a time; the
  // quarter lock stays a now-starting purchase.
  const nextTerm = String(body.term ?? '') === 'next';
  const months = !nextTerm && String(body.months ?? '1').trim() === String(QUARTER_MONTHS)
    ? QUARTER_MONTHS
    : 1;

  const now = Date.now();
  const slots = await sponsorSlots();
  const slot = slots.find((s) => s.id === slotId);
  if (!slot) return fail(wantsJson, 'unknown slot', 400);
  // The quarter lock is a big-slot deal only.
  if (months > 1 && slot.price_cents < QUARTER_MIN_CENTS) {
    return fail(wantsJson, 'not on this slot', 400);
  }

  // Only money closes a slot. Another open checkout session is not a reason to
  // turn anyone away — several people racing for the same slot is the design.
  const before = await activePurchases();
  let startsAt = null;
  let endsAt = null;
  if (nextTerm) {
    /* Selling the slot's NEXT run while the current one finishes out. It must
       be marked open, the slot must actually be mid-run (a slot that's free
       right now sells through the normal flow), nobody may have paid for the
       next term already, and the current run may not extend into it beyond
       the allowed spill. */
    startsAt = nextRunStart(now);
    endsAt = startsAt + RUN_MS;
    const held = before.filter((p) => p.slot_id === slotId && p.status !== 'hold');
    if (slot.next_state !== 'open') return fail(wantsJson, TAKEN, 409);
    if (!held.some((p) => blocksSlot(p, now))) return fail(wantsJson, TAKEN, 409);
    if (held.some((p) => p.starts_at && p.starts_at > now)) return fail(wantsJson, TAKEN, 409);
    // A blocked row with no end date yet (paid, awaiting approval) could end
    // anywhere — refuse rather than guess.
    if (held.some((p) => blocksSlot(p, now) && (p.ends_at ?? Number.MAX_SAFE_INTEGER) > startsAt + SPILL_MS)) {
      return fail(wantsJson, TAKEN, 409);
    }
  } else if (before.some((p) => p.slot_id === slotId && blocksSlot(p, now))) {
    return fail(wantsJson, TAKEN, 409);
  }

  /* The hold row exists to tie the Stripe session to a purchase, and to give the
     webhook something to promote. It reserves nothing. */
  const purchase = {
    id: crypto.randomUUID(),
    slot_id: slotId,
    status: 'hold',
    amount_cents: slot.price_cents * months,
    months,
    details_token: newToken(),
    created_at: now,
    hold_expires_at: now + HOLD_TTL_MS,
  };
  await insertPurchase(purchase);
  // A next-run hold carries its term from the start; promotion and approval
  // both preserve future dates.
  if (nextTerm) {
    const stamped = await updatePurchase(purchase.id, { starts_at: startsAt, ends_at: endsAt }, ['hold']);
    if (!stamped) {
      console.error(`next-term hold ${purchase.id} lost its term stamp`);
      return fail(wantsJson, 'checkout unavailable', 502);
    }
  }

  let session;
  try {
    session = await createCheckoutSession({
      purchaseId: purchase.id,
      slotId,
      priceCents: slot.price_cents * months,
      months,
      termNote: nextTerm ? `Runs ${shortDate(startsAt)} to ${shortDate(endsAt)}.` : '',
      successUrl: `${siteUrl('/sponsor/details')}?t=${purchase.details_token}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: siteUrl('/sponsor'),
      expiresAt: now + SESSION_TTL_MS,
    });
  } catch (err) {
    console.error(`sponsor checkout failed: ${err?.message || err}`);
    await updatePurchase(purchase.id, { status: 'expired_hold' }, ['hold']);
    return fail(wantsJson, 'checkout unavailable', 502);
  }

  await updatePurchase(purchase.id, { stripe_session_id: session.id }, ['hold']);

  if (wantsJson) return json({ url: session.url });
  // A plain form post lands straight on Stripe, so the page works without JS.
  return new Response(null, { status: 303, headers: { Location: session.url } });
}

// JSON callers get the status code; a plain form post gets sent back to the
// board with the reason, because a bare 409 page helps nobody.
function fail(wantsJson, error, status) {
  if (wantsJson) return json({ error }, status);
  return new Response(null, {
    status: 303,
    headers: { Location: `/sponsor?error=${encodeURIComponent(error)}` },
  });
}
