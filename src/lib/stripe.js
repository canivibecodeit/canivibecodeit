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
            name: `canivibecodeit.com · sponsor slot (${30 * months} days)`,
            description:
              `Your product on every page of canivibecodeit.com for ${30 * months} days: icon, name,`
              + ' tagline and link, plus the sponsor board.'
              + (months > 1 ? ' Price locked for the full run.' : '')
              + (termNote ? ` ${termNote}` : ''),
          },
        },
      },
    ],
  });
}

/* Checkout for a monthly sponsor subscription. Same buyer profile as the
   one-off checkout (business tax id, billing address), minus the options
   Stripe refuses in subscription mode: a subscription always creates a
   Customer and always invoices. The subscription's own metadata carries the
   purchase id, so every later invoice can be traced back to its row. */
export async function createSubscriptionCheckoutSession({
  purchaseId, slotId, priceCents, successUrl, cancelUrl, expiresAt,
}) {
  const metadata = { kind: 'sponsor_slot', purchase_id: purchaseId, slot_id: slotId };
  return stripeFetch(
    '/v1/checkout/sessions',
    {
      mode: 'subscription',
      'payment_method_types[]': 'card',
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_at: Math.floor(expiresAt / 1000),
      client_reference_id: purchaseId,
      metadata,
      subscription_data: { metadata },
      adaptive_pricing: { enabled: false },
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: priceCents,
            recurring: { interval: 'month' },
            product_data: {
              name: 'canivibecodeit.com · sponsor slot (monthly)',
              description:
                'Your product on every page of canivibecodeit.com: icon, name, tagline and link.'
                + ' Billed monthly until you cancel. Cancel any time.'
                + ' No refunds once your card is live.',
            },
          },
        },
      ],
    },
    'POST',
    `subcheckout-${purchaseId}`
  );
}

export async function getSubscription(id) {
  return stripeFetch(`/v1/subscriptions/${encodeURIComponent(id)}`, null, 'GET');
}

export async function getInvoice(id) {
  return stripeFetch(`/v1/invoices/${encodeURIComponent(id)}`, null, 'GET');
}

export async function getCustomer(id) {
  return stripeFetch(`/v1/customers/${encodeURIComponent(id)}`, null, 'GET');
}

// Ends billing now. Nothing is prorated or refunded by this call.
export async function cancelSubscriptionNow(id, idempotencyKey) {
  return stripeFetch(`/v1/subscriptions/${encodeURIComponent(id)}`, null, 'DELETE', idempotencyKey);
}

// Stops renewing at the end of the paid period (or undoes that).
export async function setCancelAtPeriodEnd(id, value = true) {
  return stripeFetch(`/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: value });
}

/* ---------- subscription shapes ----------

   The webhook payload follows the endpoint's API version, which is set in
   the dashboard, not here. Stripe moved these fields in 2025 (invoice.parent,
   invoice.payments, items[].current_period_end), so every reader accepts the
   older and the newer shape alike. */

const idOf = (v) => (typeof v === 'string' ? v : v?.id ?? null);

export function invoiceSubscriptionId(inv) {
  return idOf(inv?.parent?.subscription_details?.subscription) ?? idOf(inv?.subscription) ?? null;
}

export function invoiceSubscriptionMeta(inv) {
  return inv?.parent?.subscription_details?.metadata ?? inv?.subscription_details?.metadata ?? {};
}

// The end of the latest period this invoice pays for, in ms.
export function invoicePeriodEnd(inv) {
  const ends = (inv?.lines?.data ?? []).map((l) => Number(l?.period?.end) || 0);
  const end = Math.max(0, ...ends);
  return end > 0 ? end * 1000 : null;
}

export function invoicePeriodStart(inv) {
  const starts = (inv?.lines?.data ?? []).map((l) => Number(l?.period?.start) || 0).filter(Boolean);
  return starts.length ? Math.min(...starts) * 1000 : null;
}

export function subscriptionPeriod(sub) {
  const item = sub?.items?.data?.[0] ?? {};
  const start = Number(sub?.current_period_start ?? item.current_period_start) || 0;
  const end = Number(sub?.current_period_end ?? item.current_period_end) || 0;
  return { start: start ? start * 1000 : null, end: end ? end * 1000 : null };
}

// The card's money: the payment intent behind an invoice, whichever shape it came in.
function invoicePaymentIntent(inv) {
  if (inv?.payment_intent) return { payment_intent: idOf(inv.payment_intent) };
  if (inv?.charge) return { charge: idOf(inv.charge) };
  for (const p of inv?.payments?.data ?? []) {
    const pi = p?.payment?.payment_intent;
    if (pi && (p.status === 'paid' || !p.status)) return { payment_intent: idOf(pi) };
  }
  return null;
}

/* Refunds what an invoice collected, in full. Looks the invoice up with its
   payments expanded when the shape at hand doesn't name them. */
export async function refundInvoice(invoiceId, idempotencyKey) {
  let target = null;
  try {
    target = invoicePaymentIntent(
      await stripeFetch(`/v1/invoices/${encodeURIComponent(invoiceId)}?expand[]=payments`, null, 'GET')
    );
  } catch {
    target = invoicePaymentIntent(await getInvoice(invoiceId));
  }
  if (!target) throw new Error(`no payment found on invoice ${invoiceId}`);
  return stripeFetch('/v1/refunds', target, 'POST', idempotencyKey);
}

// Every paid invoice of a subscription, newest first (a sponsor subscription
// never gets near the page size).
export async function listPaidInvoices(subscriptionId) {
  const q = `subscription=${encodeURIComponent(subscriptionId)}&status=paid&limit=100`;
  return (await stripeFetch(`/v1/invoices?${q}`, null, 'GET'))?.data ?? [];
}

export async function invoiceAlreadyRefunded(invoiceId) {
  let target = null;
  try {
    target = invoicePaymentIntent(
      await stripeFetch(`/v1/invoices/${encodeURIComponent(invoiceId)}?expand[]=payments`, null, 'GET')
    );
  } catch {
    target = invoicePaymentIntent(await getInvoice(invoiceId));
  }
  if (!target) return false;
  const q = target.payment_intent
    ? `payment_intent=${encodeURIComponent(target.payment_intent)}`
    : `charge=${encodeURIComponent(target.charge)}`;
  const list = await stripeFetch(`/v1/refunds?${q}&limit=10`, null, 'GET');
  return (list?.data ?? []).some((r) => r.status === 'succeeded' || r.status === 'pending');
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
              name: 'canivibecodeit.com · sponsored placement',
              description:
                'Advertising placement on the canivibecodeit.com board: your icon, name,'
                + ' tagline and link, ranked by cumulative sponsorship. Subject to the'
                + ' Build Games terms: canivibecodeit.com/thebuildgames/terms',
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
