import crypto from 'node:crypto';
import {
  activePurchases, insertPurchase, rateLimit, sponsorSlots, updatePurchase,
} from '../../../lib/db.js';
import { clientIp, json, readBody } from '../../../lib/request.js';
// No clearCache here: holds never appear on the board, so creating or expiring
// one cannot change what the rails render.
import {
  blocksSlot, HOLD_TTL_MS, newToken, SESSION_TTL_MS, siteUrl, SLOT_IDS, sponsorPriceCents,
} from '../../../lib/sponsors.js';
import { createSubscriptionCheckoutSession } from '../../../lib/stripe.js';

const TAKEN = 'that slot just went';

/* "take this slot": a monthly subscription at the one price in
   sponsorPriceCents. The first payment follows the flow it always has (paid,
   card details, approval by hand, live); every renewal after it extends the
   run (see the webhook). */
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

  const now = Date.now();
  const slots = await sponsorSlots();
  if (!slots.some((s) => s.id === slotId)) return fail(wantsJson, 'unknown slot', 400);

  // Only money closes a slot. Another open checkout session is not a reason to
  // turn anyone away — several people racing for the same slot is the design.
  if ((await activePurchases()).some((p) => p.slot_id === slotId && blocksSlot(p, now))) {
    return fail(wantsJson, TAKEN, 409);
  }

  const priceCents = sponsorPriceCents();
  /* The hold row exists to tie the Stripe session to a purchase, and to give the
     webhook something to promote. It reserves nothing. */
  const purchase = {
    id: crypto.randomUUID(),
    slot_id: slotId,
    status: 'hold',
    amount_cents: priceCents,
    months: 1,
    details_token: newToken(),
    created_at: now,
    hold_expires_at: now + HOLD_TTL_MS,
  };
  await insertPurchase(purchase);

  let session;
  try {
    session = await createSubscriptionCheckoutSession({
      purchaseId: purchase.id,
      slotId,
      priceCents,
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
