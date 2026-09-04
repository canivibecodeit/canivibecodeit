/* Stripe over plain fetch — the REST API is form-encoded and the webhook
   signature is an HMAC, so the SDK would earn its dependency on neither. */

import crypto from 'node:crypto';

const API = 'https://api.stripe.com';
const SIGNATURE_TOLERANCE_S = 300;

// Stripe's bracket syntax: nested objects and arrays flatten to a[b][0][c]=v.
function encode(value, prefix, out) {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => encode(v, `${prefix}[${i}]`, out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) encode(v, `${prefix}[${k}]`, out);
  } else {
    out.append(prefix, String(value));
  }
  return out;
}

function form(params) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) encode(v, k, out);
  return out;
}

/* `idempotencyKey` makes a retry after a lost response safe: Stripe replays the
   original result instead of performing the action twice. */
export async function stripeFetch(pathname, params, method = 'POST', idempotencyKey) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('missing STRIPE_SECRET_KEY');
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: method === 'POST' ? form(params || {}).toString() : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`stripe ${pathname}: HTTP ${res.status} ${json?.error?.message || ''}`.trim());
  }
  return json;
}

export async function createCheckoutSession({
  purchaseId, slotId, priceCents, successUrl, cancelUrl, expiresAt, months = 1, termNote = '',
}) {
  return stripeFetch('/v1/checkout/sessions', {
    mode: 'payment',
    'payment_method_types[]': 'card',
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: Math.floor(expiresAt / 1000),
    client_reference_id: purchaseId,
    metadata: { purchase_id: purchaseId, slot_id: slotId, months },
    payment_intent_data: { metadata: { purchase_id: purchaseId, slot_id: slotId, months } },
    // Same reason as the Build Games checkout: Adaptive Pricing would settle a
    // non-US buyer in their own currency, which our handlers do not accept.
    adaptive_pricing: { enabled: false },
    // Sponsors buy as businesses: let them enter a VAT/tax ID and company name,
    // and have Stripe email a proper invoice PDF after payment (0.4% capped at
    // $2 per invoice). The tax ID needs a Customer to live on.
    tax_id_collection: { enabled: true },
    billing_address_collection: 'required',
    customer_creation: 'always',
    invoice_creation: { enabled: true },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: priceCents,
          product_data: {
            name: `vibecodeit.com · sponsor slot (${30 * months} days)`,
            description:
              `Your product on every page of vibecodeit.com for ${30 * months} days: icon, name,`
              + ' tagline and link, plus the sponsor board.'
              + (months > 1 ? ' Price locked for the full run.' : '')
              + (termNote ? ` ${termNote}` : ''),
          },
        },
      },
    ],
  });
}

/* Checkout for a Build Games placement. COPY DISCIPLINE (non-negotiable, from
   the payments research): the checkout page and the Stripe product/description
   say "sponsor placement / advertising" and NEVER bid/stake/prize/entry —
   site copy can say bid, the payment surface cannot. metadata.kind is the
   webhook's discriminator; the payment_intent carries it too so refund and
   dispute events can be traced back without a session lookup. */
export async function createBidCheckoutSession({
  paymentId, sponsorId, amountCents, successUrl, cancelUrl, customerEmail,
}) {
  const metadata = { kind: 'buildgames', payment_id: paymentId, sponsor_id: sponsorId };
  return stripeFetch(
    '/v1/checkout/sessions',
    {
      mode: 'payment',
      'payment_method_types[]': 'card',
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Unpaid sessions die after 30 minutes so pending rows don't linger.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      client_reference_id: paymentId,
      metadata,
      payment_intent_data: { metadata },
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      // Adaptive Pricing is ON by default and would charge non-US buyers in
      // their local currency. The webhook only accepts a usd capture, so an
      // international sponsor would be charged and get NO placement and no
      // message. Force usd for everyone: one currency in, one currency out.
      adaptive_pricing: { enabled: false },
      // Same business-buyer posture as the sponsor checkout: tax id field and
      // a proper invoice PDF after payment.
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      customer_creation: 'always',
      invoice_creation: { enabled: true },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: {
              name: 'vibecodeit.com · sponsored placement',
              description:
                'Advertising placement on the vibecodeit.com board: your icon, name,'
                + ' tagline and link, ranked by cumulative sponsorship. Subject to the'
                + ' Build Games terms: vibecodeit.com/thebuildgames/terms',
            },
          },
        },
      ],
    },
    'POST',
    // Retried submits reuse the same session instead of minting a second.
    `bgcheckout-${paymentId}`
  );
}

/* A shareable, non-expiring checkout URL for exactly one sale: the link
   deactivates after its first completed payment, so a forwarded or re-clicked
   link can't charge twice. Payment links need a real Price object, so this is
   two calls; the link's metadata is copied onto the checkout session it
   produces, which is what the webhook reconciles on. The same idempotency key
   within 24h returns the same link instead of minting another. */
export async function createPaymentLink({ name, priceCents, metadata, idempotencyKey }) {
  const price = await stripeFetch(
    '/v1/prices',
    {
      currency: 'usd',
      unit_amount: priceCents,
      product_data: { name },
    },
    'POST',
    idempotencyKey ? `${idempotencyKey}-price` : undefined
  );
  return stripeFetch(
    '/v1/payment_links',
    {
      line_items: [{ price: price.id, quantity: 1 }],
      metadata,
      restrictions: { completed_sessions: { limit: 1 } },
      // Same buyer profile as the self-serve checkout: business buyers get to
      // enter a tax id and receive a proper invoice PDF.
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      customer_creation: 'always',
      invoice_creation: { enabled: true },
    },
    'POST',
    idempotencyKey ? `${idempotencyKey}-link` : undefined
  );
}

export async function getSession(id) {
  return stripeFetch(`/v1/checkout/sessions/${encodeURIComponent(id)}`, null, 'GET');
}

export async function expireSession(id) {
  return stripeFetch(`/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
}

export async function createRefund(paymentIntent, idempotencyKey) {
  return stripeFetch('/v1/refunds', { payment_intent: paymentIntent }, 'POST', idempotencyKey);
}

export async function listRefunds(paymentIntent, limit = 10) {
  const q = `payment_intent=${encodeURIComponent(paymentIntent)}&limit=${limit}`;
  return stripeFetch(`/v1/refunds?${q}`, null, 'GET');
}

/* A refund that already exists — settled or still moving — means the money is on
   its way back and a second one must not be created. Failed and cancelled
   refunds don't count: those are exactly the ones worth retrying. */
export async function alreadyRefunded(paymentIntent) {
  const list = await listRefunds(paymentIntent);
  return (list?.data ?? []).some((r) => r.status === 'succeeded' || r.status === 'pending');
}

/* Verifies the Stripe-Signature header against the raw request body. The body
   must be the exact bytes Stripe sent — parsing it first breaks the HMAC. */
export function verifyStripeSignature(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  let timestamp = null;
  const candidates = [];
  for (const part of String(header).split(',')) {
    const [k, v] = part.split('=', 2);
    if (k?.trim() === 't') timestamp = v?.trim();
    else if (k?.trim() === 'v1' && v) candidates.push(v.trim());
  }
  if (!timestamp || candidates.length === 0) return false;
  // A replayed old delivery is rejected outright rather than re-processed.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_S) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return candidates.some(
    (sig) =>
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  );
}
