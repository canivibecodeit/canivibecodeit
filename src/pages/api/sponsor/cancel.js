import { purchaseByToken, rateLimit } from '../../../lib/db.js';
import { clientIp, json, readBody } from '../../../lib/request.js';
import { applySubscriptionUpdate } from '../../../lib/sponsor-subscriptions.js';
import { isSubscription } from '../../../lib/sponsors.js';
import { setCancelAtPeriodEnd } from '../../../lib/stripe.js';

/* The sponsor's own "cancel": stops renewal at the end of the paid period.
   The card keeps every day already paid for. Authorised by the same
   per-purchase token as the stats page it is posted from. */
export async function POST({ request, clientAddress }) {
  const ip = clientIp(request, clientAddress);
  const wantsJson = (request.headers.get('content-type') || '').includes('application/json');
  if (!(await rateLimit(`sponsor-cancel:${ip}`, 10, 60 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const token = String(body.t ?? '').trim();
  const purchase = token ? await purchaseByToken(token) : null;
  if (!purchase || !isSubscription(purchase)) return json({ error: 'not found' }, 404);

  const back = (msg) => {
    if (wantsJson) return json({ ok: true, message: msg });
    return new Response(null, {
      status: 303,
      headers: { Location: `/sponsor/stats?t=${encodeURIComponent(token)}&msg=${encodeURIComponent(msg)}` },
    });
  };

  if (purchase.cancel_at || purchase.canceled_at) return back('already cancelled');
  if (!['paid', 'submitted', 'live'].includes(purchase.status)) return back('nothing left to cancel');

  try {
    const sub = await setCancelAtPeriodEnd(purchase.stripe_subscription_id, true);
    await applySubscriptionUpdate(sub);
  } catch (err) {
    console.error(`sponsor cancel ${purchase.id} failed: ${err?.message || err}`);
    if (wantsJson) return json({ error: 'could not cancel; email hello@canivibecodeit.com' }, 502);
    return back('could not cancel right now; email hello@canivibecodeit.com');
  }
  return back('cancelled');
}
