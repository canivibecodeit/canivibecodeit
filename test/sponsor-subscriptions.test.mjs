/* Sponsor subscriptions: checkout in subscription mode, the first payment,
   approval, renewals, a failed renewal and its week-long hold, late payments,
   cancellation, the sponsor's own cancel button, attaching a subscription paid
   through a hand-issued link, and the concurrent / out-of-order / failing
   cases from the review of cf2d20e (numbers in the test names).

   Runs against a throwaway SQLite database, or Postgres when
   SUBS_TEST_DATABASE_URL points at a throwaway one, and a fake Stripe (and a
   fake mail API) behind globalThis.fetch. Run: npm test */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dir = mkdtempSync(path.join(tmpdir(), 'cvci-subs-'));
const PG = !!process.env.SUBS_TEST_DATABASE_URL;
if (PG) process.env.DATABASE_URL = process.env.SUBS_TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;
delete process.env.ORIGIN_VERIFY_SECRET;
delete process.env.SPONSOR_PRICE_CENTS;
delete process.env.RESERVED_SLOTS;
process.env.DATA_DIR = dir;
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.RESEND_API_KEY = 're_test_fake';
process.env.DIGEST_ALERT_EMAIL = 'rob@example.test';
process.env.ADMIN_TOKEN = 'admin-test-token';
process.env.SITE_URL = 'https://example.test';

const DAY = 24 * 60 * 60 * 1000;
const sec = (ms) => Math.floor(ms / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- fake Stripe + mail ---------- */

const stripe = {
  subs: new Map(), invoices: new Map(), customers: new Map(), sessionObjs: new Map(),
  calls: [], refunds: [], sessions: [], delay: 0,
};
const mails = [];
const toRob = () => mails.filter((m) => m.to === 'rob@example.test');
const toBuyer = () => mails.filter((m) => m.to !== 'rob@example.test');

async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const method = init.method || 'GET';
  const body = init.body ? new URLSearchParams(init.body) : null;
  const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  const nope = (msg, status = 404) => new Response(JSON.stringify({ error: { message: msg } }), { status });
  if (u.host === 'api.resend.com') {
    mails.push(JSON.parse(init.body));
    return ok({ id: 'mail' });
  }
  if (u.host !== 'api.stripe.com') return nope('unexpected host');
  stripe.calls.push({ method, path: u.pathname, body, query: u.searchParams });
  // A small, uneven delay on every Stripe call lets concurrent handlers interleave.
  if (stripe.delay) await sleep(1 + Math.floor(Math.random() * stripe.delay));
  let m;
  if (u.pathname === '/v1/checkout/sessions' && method === 'POST') {
    const s = { id: `cs_test_${stripe.sessions.length + 1}_${crypto.randomUUID().slice(0, 6)}`, url: 'https://checkout.stripe.test/s', body };
    stripe.sessions.push(s);
    return ok(s);
  }
  if ((m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
    const s = stripe.sessionObjs.get(m[1]);
    return s ? ok(s) : nope('No such checkout session');
  }
  if ((m = /^\/v1\/subscriptions\/([^/]+)$/.exec(u.pathname))) {
    const sub = stripe.subs.get(m[1]);
    if (!sub) return nope('No such subscription');
    if (method === 'GET') return ok(structuredClone(sub));
    if (method === 'DELETE') {
      if (sub.status === 'canceled') return nope('This subscription has already been canceled', 400);
      sub.status = 'canceled';
      return ok(structuredClone(sub));
    }
    if (method === 'POST') {
      if (body.has('cancel_at_period_end')) sub.cancel_at_period_end = body.get('cancel_at_period_end') === 'true';
      return ok(structuredClone(sub));
    }
  }
  if (u.pathname === '/v1/invoices' && method === 'GET') {
    const subId = u.searchParams.get('subscription');
    const status = u.searchParams.get('status');
    return ok({ data: [...stripe.invoices.values()].filter((i) => i._sub === subId && (!status || i.status === status)).reverse() });
  }
  if ((m = /^\/v1\/invoices\/([^/]+)$/.exec(u.pathname))) {
    const inv = stripe.invoices.get(m[1]);
    return inv ? ok(inv) : nope('No such invoice');
  }
  if ((m = /^\/v1\/customers\/([^/]+)$/.exec(u.pathname))) {
    return ok(stripe.customers.get(m[1]) ?? { id: m[1], email: null });
  }
  if (u.pathname === '/v1/refunds' && method === 'POST') {
    const r = { ...Object.fromEntries(body.entries()), status: 'succeeded' };
    stripe.refunds.push(r);
    return ok({ id: `re_${stripe.refunds.length}`, ...r });
  }
  if (u.pathname === '/v1/refunds' && method === 'GET') {
    const pi = u.searchParams.get('payment_intent');
    return ok({ data: stripe.refunds.filter((r) => r.payment_intent === pi) });
  }
  return nope(`unhandled ${method} ${u.pathname}`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => fakeFetch(String(url), init);

function addSub(id, { start, end, status = 'active', email = 'buyer@example.test', amount = 100000, newShape = true } = {}) {
  const cus = `cus_${id}`;
  stripe.customers.set(cus, { id: cus, email });
  const sub = {
    id, status, customer: cus, cancel_at_period_end: false, cancel_at: null,
    latest_invoice: `in_${id}_1`,
    items: { data: [{ price: { unit_amount: amount }, ...(newShape ? { current_period_start: sec(start), current_period_end: sec(end) } : {}) }] },
    ...(newShape ? {} : { current_period_start: sec(start), current_period_end: sec(end) }),
  };
  stripe.subs.set(id, sub);
  stripe.invoices.set(`in_${id}_1`, { id: `in_${id}_1`, _sub: id, status: 'paid', amount_paid: amount, payment_intent: `pi_${id}_1` });
  return sub;
}

// Moves the fake subscription to a new period (what Stripe does on renewal).
function setPeriod(subId, start, end) {
  const sub = stripe.subs.get(subId);
  sub.items.data[0].current_period_start = sec(start);
  sub.items.data[0].current_period_end = sec(end);
}

// An invoice for a subscription, in either API shape.
function invoice(id, subId, start, end, { newShape = true, reason = 'subscription_cycle', meta = {}, status = 'paid' } = {}) {
  const inv = {
    id, object: 'invoice', billing_reason: reason, amount_paid: status === 'paid' ? 100000 : 0, _sub: subId, status,
    hosted_invoice_url: 'https://invoice.stripe.test/i',
    lines: { data: [{ period: { start: sec(start), end: sec(end) } }] },
    ...(newShape
      ? { parent: { subscription_details: { subscription: subId, metadata: meta } }, payments: { data: [{ status: 'paid', payment: { payment_intent: `pi_${id}` } }] } }
      : { subscription: subId, subscription_details: { metadata: meta }, payment_intent: `pi_${id}` }),
  };
  stripe.invoices.set(id, inv);
  return inv;
}

/* ---------- modules under test ---------- */

let db, sponsors, stripeLib, webhook, checkout, admin, cancel, subs, details;

before(async () => {
  db = await import('../src/lib/db.js');
  sponsors = await import('../src/lib/sponsors.js');
  stripeLib = await import('../src/lib/stripe.js');
  subs = await import('../src/lib/sponsor-subscriptions.js');
  webhook = await import('../src/pages/api/sponsor/webhook.js');
  checkout = await import('../src/pages/api/sponsor/checkout.js');
  admin = await import('../src/pages/api/sponsor/admin.js');
  cancel = await import('../src/pages/api/sponsor/cancel.js');
  details = await import('../src/pages/api/sponsor/details.js');
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

let ipSeq = 0;
beforeEach(() => {
  stripe.calls.length = 0;
  stripe.refunds.length = 0;
  stripe.delay = 0;
  mails.length = 0;
  sponsors.clearCache();
});

const freshIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const formReq = (url, fields, headers = {}) =>
  new Request(`https://example.test${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp(), ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const jsonReq = (url, obj) =>
  new Request(`https://example.test${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify(obj),
  });

async function deliver(type, object, { expect = 200, id = `evt_${crypto.randomUUID()}` } = {}) {
  const raw = JSON.stringify({ id, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  const res = await webhook.POST({
    request: new Request('https://example.test/api/sponsor/webhook', {
      method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: raw,
    }),
  });
  assert.equal(res.status, expect, `${type} answered ${res.status}`);
  return res;
}

const adminPost = (fields) => admin.POST({ request: jsonReq('/api/sponsor/admin', { token: process.env.ADMIN_TOKEN, ...fields }) });

// The ten slots are reused across tests: free one before using it.
async function free(slot) {
  for (const p of await db.activePurchases()) {
    if (p.slot_id === slot) await db.updatePurchase(p.id, { status: 'expired', ends_at: Date.now() - 1 });
  }
  sponsors.clearCache();
}

const sessionFor = (s, subId, extra = {}) => ({
  id: s.id, mode: 'subscription', status: 'complete', payment_status: 'paid', payment_intent: null,
  subscription: subId, invoice: `in_${subId}_1`, amount_total: 100000,
  client_reference_id: s.body.get('metadata[purchase_id]'),
  metadata: { purchase_id: s.body.get('metadata[purchase_id]'), slot_id: s.body.get('metadata[slot_id]'), kind: 'sponsor_slot' },
  customer_details: { email: `${subId}@example.test` },
  ...extra,
});

async function startCheckout(slot) {
  const res = await checkout.POST({ request: formReq('/api/sponsor/checkout', { slot }), clientAddress: '10.9.9.9' });
  assert.equal(res.status, 303);
  return stripe.sessions.at(-1);
}

/* Checkout → paid → details → approved, through the real endpoints. */
async function subscribeAndApprove(slot, subId, { paidAt = Date.now() } = {}) {
  await free(slot);
  const s = await startCheckout(slot);
  addSub(subId, { start: paidAt, end: paidAt + 30 * DAY });
  await deliver('checkout.session.completed', sessionFor(s, subId));
  const purchaseId = s.body.get('metadata[purchase_id]');
  const row = await db.purchaseById(purchaseId);
  const sent = await details.POST({
    request: jsonReq('/api/sponsor/details', { t: row.details_token, name: 'Acme', tagline: 'Things for builders', url: 'acme.test' }),
    clientAddress: '10.9.9.9',
  });
  assert.equal(sent.status, 200);
  const approved = await adminPost({ action: 'approve', id: purchaseId });
  assert.equal(approved.status, 200);
  return db.purchaseById(purchaseId);
}

/* A database write that fails for one row, on either driver (finding 1). */
async function failWritesFor(id) {
  const raw = await db.authDatabase();
  const safe = id.replace(/[^a-z0-9-]/gi, '');
  if (PG) {
    await raw.query(`CREATE OR REPLACE FUNCTION cvci_test_fail() RETURNS trigger AS $$
      BEGIN IF OLD.id = '${safe}' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await raw.query('DROP TRIGGER IF EXISTS cvci_test_fail ON sponsor_purchases');
    await raw.query('CREATE TRIGGER cvci_test_fail BEFORE UPDATE ON sponsor_purchases FOR EACH ROW EXECUTE FUNCTION cvci_test_fail()');
  } else {
    raw.exec(`CREATE TRIGGER cvci_test_fail BEFORE UPDATE ON sponsor_purchases WHEN OLD.id = '${safe}'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  }
}
async function healWrites() {
  const raw = await db.authDatabase();
  if (PG) await raw.query('DROP TRIGGER IF EXISTS cvci_test_fail ON sponsor_purchases');
  else raw.exec('DROP TRIGGER IF EXISTS cvci_test_fail');
}

/* ---------- pure parts ---------- */

test('one price, from config, with a safe default', () => {
  assert.equal(sponsors.sponsorPriceCents({}), 100000);
  assert.equal(sponsors.sponsorPriceCents({ SPONSOR_PRICE_CENTS: '125000' }), 125000);
  assert.equal(sponsors.sponsorPriceCents({ SPONSOR_PRICE_CENTS: 'abc' }), 100000);
  assert.equal(sponsors.sponsorPriceCents({ SPONSOR_PRICE_CENTS: '12.5' }), 100000);
  assert.equal(sponsors.sponsorPriceCents({ SPONSOR_PRICE_CENTS: '0' }), 100000);
});

test('term arithmetic: approval counts from approval; grace, week-long hold, or nothing', () => {
  const paidAt = Date.UTC(2026, 10, 1);
  const p = { paid_at: paidAt, paid_through: paidAt + 30 * DAY };
  const t = sponsors.approvalTerm(p, paidAt + 6 * 60 * 60 * 1000);
  assert.equal(t.shift_ms, 6 * 60 * 60 * 1000);
  assert.equal(t.ends_at, paidAt + 30 * DAY + t.shift_ms + sponsors.RENEWAL_GRACE_MS);
  assert.equal(sponsors.paidEndAt({ ...p, ...t }), paidAt + 30 * DAY + t.shift_ms);
  assert.equal(sponsors.approvalTerm({ ...p, cancel_at: paidAt + 30 * DAY }, paidAt).ends_at, paidAt + 30 * DAY);
  assert.equal(sponsors.subscriptionEndsAt({ paidThrough: null }), null);
  assert.equal(sponsors.FAILED_HOLD_MS, 7 * DAY);
  assert.equal(sponsors.subscriptionMode({ status: 'active' }), 'renewing');
  assert.equal(sponsors.subscriptionMode({ status: 'past_due' }), 'retrying');
  assert.equal(sponsors.subscriptionMode({ status: 'past_due', cancel_at_period_end: true }), 'ending');
  assert.equal(sponsors.subscriptionMode({ status: 'active', cancel_at: 123 }), 'ending');
  assert.equal(sponsors.subscriptionMode({ status: 'unpaid' }), 'ending');
  assert.equal(sponsors.subscriptionMode({ status: 'canceled' }), 'ending');
});

test('Stripe shapes: old and new invoice and subscription fields read the same', () => {
  const s = Date.UTC(2026, 10, 1);
  const e = s + 30 * DAY;
  for (const newShape of [true, false]) {
    const inv = invoice(`in_shape_${newShape}`, 'sub_shape1', s, e, { newShape, meta: { purchase_id: 'p1' } });
    assert.equal(stripeLib.invoiceSubscriptionId(inv), 'sub_shape1');
    assert.equal(stripeLib.invoiceSubscriptionMeta(inv).purchase_id, 'p1');
    assert.equal(stripeLib.invoicePeriodEnd(inv), e);
    const sub = addSub(`sub_shape_${newShape}`, { start: s, end: e, newShape });
    assert.deepEqual(stripeLib.subscriptionPeriod(sub), { start: s, end: e });
  }
  assert.equal(stripeLib.invoiceSubscriptionId({ id: 'in_x' }), null);
});

/* ---------- the life of a subscription ---------- */

test('checkout opens a monthly Stripe subscription at the configured price', async () => {
  const res = await checkout.POST({ request: formReq('/api/sponsor/checkout', { slot: 'L5', months: '3' }), clientAddress: '1.1.1.1' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://checkout.stripe.test/s');
  const b = stripe.sessions.at(-1).body;
  assert.equal(b.get('mode'), 'subscription');
  assert.equal(b.get('line_items[0][price_data][unit_amount]'), '100000');
  assert.equal(b.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(b.get('subscription_data[metadata][purchase_id]'), b.get('metadata[purchase_id]'));
  assert.equal(b.has('customer_creation'), false);
  assert.equal(b.has('invoice_creation[enabled]'), false);
  const row = await db.purchaseById(b.get('metadata[purchase_id]'));
  assert.equal(row.status, 'hold');
  assert.equal(row.amount_cents, 100000);
  assert.equal(row.months, 1, 'the three-month lock is gone');
});

test('first payment, details, approval, renewal: a month from approval, extended by each renewal', async () => {
  const row = await subscribeAndApprove('L1', 'sub_life1');
  assert.equal(row.status, 'live');
  assert.equal(row.stripe_subscription_id, 'sub_life1');
  assert.equal(row.ends_at, row.paid_through + row.shift_ms + sponsors.RENEWAL_GRACE_MS);
  assert.ok(toBuyer().some((m) => m.subject === "you're live on canivibecodeit" && m.html.includes('/sponsor/stats?t=')));
  assert.equal((await sponsors.getBoard()).slots.find((s) => s.id === 'L1').state, 'live');

  const next = invoice('in_life1_2', 'sub_life1', row.paid_through, row.paid_through + 31 * DAY);
  await deliver('invoice.paid', next);
  const renewed = await db.purchaseById(row.id);
  assert.equal(renewed.paid_through, row.paid_through + 31 * DAY);
  assert.equal(renewed.ends_at, renewed.paid_through + row.shift_ms + sponsors.RENEWAL_GRACE_MS);
  assert.ok(toRob().some((m) => /sponsor renewed/.test(m.subject)), 'Rob hears about each renewal');
  const before1 = mails.length;
  await deliver('invoice.paid', next);
  assert.equal((await db.purchaseById(row.id)).ends_at, renewed.ends_at, 'a redelivery changes nothing');
  assert.equal(mails.length, before1, 'and sends nothing');
});

test('the old invoice shape renews too', async () => {
  const row = await subscribeAndApprove('L2', 'sub_old1');
  await deliver('invoice.paid', invoice('in_old1_2', 'sub_old1', row.paid_through, row.paid_through + 30 * DAY, { newShape: false }));
  assert.equal((await db.purchaseById(row.id)).paid_through, row.paid_through + 30 * DAY);
});

test('a failed renewal holds the card and the slot for 7 days, emails once, and a retry that pays carries on', async () => {
  const row = await subscribeAndApprove('L3', 'sub_fail1');
  const failed = invoice('in_fail1_2', 'sub_fail1', row.paid_through, row.paid_through + 30 * DAY, { status: 'open' });
  await deliver('invoice.payment_failed', failed);
  const held = await db.purchaseById(row.id);
  assert.equal(held.ends_at, row.paid_through + row.shift_ms + sponsors.FAILED_HOLD_MS);
  assert.ok(toBuyer().some((m) => m.subject === 'your canivibecodeit renewal did not go through' && m.html.includes('invoice.stripe.test')));
  assert.ok(toRob().some((m) => /renewal FAILED/.test(m.subject)));
  // Card up and slot held while Stripe retries (a week from the end of the paid period).
  assert.equal(sponsors.isLive(held, row.paid_through + 3 * DAY), true);
  assert.equal(sponsors.blocksSlot(held, row.paid_through + 6 * DAY), true);
  assert.equal(sponsors.blocksSlot(held, held.ends_at + 1), false, 'then the slot opens');
  const n = mails.length;
  await deliver('invoice.payment_failed', failed);
  assert.equal(mails.length, n, 'a retry that fails again sends nothing new');
  // The retry pays: Stripe sends invoice.paid, and the subscription goes active again.
  failed.status = 'paid';
  failed.amount_paid = 100000;
  await deliver('invoice.paid', failed);
  const back = await db.purchaseById(row.id);
  assert.equal(back.paid_through, row.paid_through + 30 * DAY);
  assert.equal(back.ends_at, back.paid_through + row.shift_ms + sponsors.RENEWAL_GRACE_MS);
});

test('3: a failed renewal still emails when past_due arrives before invoice.payment_failed', async () => {
  const row = await subscribeAndApprove('R5', 'sub_fail2');
  const sub = stripe.subs.get('sub_fail2');
  sub.status = 'past_due';
  await deliver('customer.subscription.updated', sub);
  assert.equal((await db.purchaseById(row.id)).ends_at, row.paid_through + row.shift_ms + sponsors.FAILED_HOLD_MS);
  mails.length = 0;
  const failed = invoice('in_fail2_2', 'sub_fail2', row.paid_through, row.paid_through + 30 * DAY, { status: 'open' });
  await deliver('invoice.payment_failed', failed);
  assert.equal(toBuyer().filter((m) => m.subject === 'your canivibecodeit renewal did not go through').length, 1);
  assert.equal(toRob().filter((m) => /renewal FAILED/.test(m.subject)).length, 1);
  // Concurrent redeliveries of the failure still send nothing more.
  await Promise.all([deliver('invoice.payment_failed', failed), deliver('invoice.payment_failed', failed)]);
  assert.equal(mails.length, 2);
});

test('the hold runs out, the card comes down, and a late retry that pays puts it back if the slot is free', async () => {
  const row = await subscribeAndApprove('L4', 'sub_late1');
  // The paid period ended 9 days ago and the week's hold is over.
  await db.updatePurchase(row.id, { paid_through: Date.now() - 9 * DAY, shift_ms: 0, ends_at: Date.now() - 2 * DAY });
  sponsors.clearCache();
  assert.equal((await sponsors.getBoard()).slots.find((s) => s.id === 'L4').state, 'open');
  await deliver('invoice.paid', invoice('in_late1_2', 'sub_late1', Date.now() - 9 * DAY, Date.now() + 21 * DAY));
  const back = await db.purchaseById(row.id);
  assert.equal(back.status, 'live');
  assert.ok(back.ends_at > Date.now() + 21 * DAY);
  assert.equal((await sponsors.getBoard()).slots.find((s) => s.id === 'L4').state, 'live');
  assert.ok(toRob().some((m) => /paid late, card back up/.test(m.subject)));
});

test('a late payment on a slot taken meanwhile is refunded and stopped, with no second alert after', async () => {
  const row = await subscribeAndApprove('R1', 'sub_late2');
  await db.updatePurchase(row.id, { paid_through: Date.now() - 9 * DAY, shift_ms: 0, ends_at: Date.now() - 2 * DAY, status: 'expired' });
  sponsors.clearCache();
  const s = await startCheckout('R1');
  addSub('sub_newcomer', { start: Date.now(), end: Date.now() + 30 * DAY });
  await deliver('checkout.session.completed', sessionFor(s, 'sub_newcomer'));
  stripe.refunds.length = 0;
  mails.length = 0;
  await deliver('invoice.paid', invoice('in_late2_2', 'sub_late2', Date.now() - 9 * DAY, Date.now() + 21 * DAY));
  const after1 = await db.purchaseById(row.id);
  assert.equal(after1.status, 'expired');
  assert.ok(after1.canceled_at);
  assert.equal(stripe.subs.get('sub_late2').status, 'canceled');
  assert.deepEqual(stripe.refunds.map((r) => r.payment_intent), ['pi_in_late2_2']);
  const n = mails.length;
  await deliver('customer.subscription.deleted', stripe.subs.get('sub_late2'));
  assert.equal(mails.length, n, '9c: our own cancellation raises no "subscription ended" alert');
});

test('cancelling keeps the paid time, un-cancelling restores the grace, deletion keeps the paid time', async () => {
  const row = await subscribeAndApprove('R2', 'sub_cancel1');
  const sub = stripe.subs.get('sub_cancel1');
  sub.cancel_at_period_end = true;
  await deliver('customer.subscription.updated', sub);
  const c = await db.purchaseById(row.id);
  assert.ok(c.cancel_at);
  assert.equal(c.ends_at, row.paid_through + row.shift_ms);
  assert.ok(toBuyer().some((m) => m.subject === 'cancelled · your sponsor card will not renew'));
  sub.cancel_at_period_end = false;
  await deliver('customer.subscription.updated', sub);
  const u = await db.purchaseById(row.id);
  assert.equal(u.cancel_at, null);
  assert.equal(u.ends_at, row.ends_at);
  sub.status = 'canceled';
  await deliver('customer.subscription.deleted', sub);
  const d = await db.purchaseById(row.id);
  assert.ok(d.canceled_at);
  assert.equal(d.ends_at, row.paid_through + row.shift_ms);
  assert.equal(d.status, 'live', 'still up until the paid period ends');
  assert.ok(toRob().some((m) => /subscription ended/.test(m.subject)));
});

test("the sponsor's cancel button: Stripe stops renewal, one email even with the webhook racing (9b)", async () => {
  const row = await subscribeAndApprove('R3', 'sub_self1');
  stripe.delay = 4;
  mails.length = 0;
  const pressed = cancel.POST({ request: formReq('/api/sponsor/cancel', { t: row.details_token }), clientAddress: '2.2.2.2' });
  const webhookToo = (async () => {
    await sleep(2);
    await deliver('customer.subscription.updated', { ...stripe.subs.get('sub_self1'), cancel_at_period_end: true });
  })();
  const [res] = await Promise.all([pressed, webhookToo]);
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /msg=cancelled/);
  assert.ok(stripe.calls.some((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_self1' && c.body.get('cancel_at_period_end') === 'true'));
  const c = await db.purchaseById(row.id);
  assert.ok(c.cancel_at);
  assert.equal(c.ends_at, row.paid_through + row.shift_ms);
  assert.equal(toBuyer().filter((m) => m.subject === 'cancelled · your sponsor card will not renew').length, 1);
  const again = await cancel.POST({ request: formReq('/api/sponsor/cancel', { t: row.details_token }), clientAddress: '2.2.2.2' });
  assert.match(again.headers.get('location'), /already%20cancelled/);
  const bad = await cancel.POST({ request: formReq('/api/sponsor/cancel', { t: 'nope' }), clientAddress: '2.2.2.2' });
  assert.equal(bad.status, 404);
});

test('9a: cancel accepted by Stripe but the local write fails: the sponsor is still told "cancelled"', async () => {
  const row = await subscribeAndApprove('R3', 'sub_self2');
  await failWritesFor(row.id);
  try {
    const res = await cancel.POST({ request: formReq('/api/sponsor/cancel', { t: row.details_token }), clientAddress: '2.2.2.3' });
    assert.match(res.headers.get('location'), /msg=cancelled/);
  } finally {
    await healWrites();
  }
  assert.equal(stripe.subs.get('sub_self2').cancel_at_period_end, true);
  // The webhook that follows records it.
  await deliver('customer.subscription.updated', stripe.subs.get('sub_self2'));
  assert.ok((await db.purchaseById(row.id)).cancel_at);
});

test('7: reject refunds every paid invoice, even a renewal paid before approval; 6: Rob hears of that renewal', async () => {
  await free('R4');
  const s = await startCheckout('R4');
  const pid = s.body.get('metadata[purchase_id]');
  addSub('sub_rej1', { start: Date.now() - 31 * DAY, end: Date.now() - DAY });
  await deliver('checkout.session.completed', sessionFor(s, 'sub_rej1'));
  // A month renews while the card is still waiting for details.
  setPeriod('sub_rej1', Date.now() - DAY, Date.now() + 29 * DAY);
  await deliver('invoice.paid', invoice('in_rej1_2', 'sub_rej1', Date.now() - DAY, Date.now() + 29 * DAY));
  assert.ok(toRob().some((m) => /renewed before the card went up/.test(m.subject)));
  const r = await adminPost({ action: 'reject', id: pid });
  assert.equal(r.status, 200);
  assert.equal((await db.purchaseById(pid)).status, 'rejected');
  assert.equal(stripe.subs.get('sub_rej1').status, 'canceled');
  assert.deepEqual(stripe.refunds.map((x) => x.payment_intent).sort(), ['pi_in_rej1_2', 'pi_sub_rej1_1']);
  const n = mails.length;
  await deliver('customer.subscription.deleted', stripe.subs.get('sub_rej1'));
  assert.equal(mails.length, n, '9c: the deletion that follows a reject raises nothing');
});

test('take-down stops billing', async () => {
  const live = await subscribeAndApprove('R4', 'sub_down1');
  const d = await adminPost({ action: 'expire', id: live.id });
  assert.equal(d.status, 200);
  const down = await db.purchaseById(live.id);
  assert.equal(down.status, 'expired');
  assert.ok(down.canceled_at);
  assert.equal(stripe.subs.get('sub_down1').status, 'canceled');
});

test('2: two subscribers whose payments land at the same time: exactly one keeps the slot', async () => {
  for (let round = 0; round < 5; round++) {
    await free('R5');
    const a = await startCheckout('R5');
    const b = await startCheckout('R5');
    addSub(`sub_raceA${round}`, { start: Date.now(), end: Date.now() + 30 * DAY });
    addSub(`sub_raceB${round}`, { start: Date.now(), end: Date.now() + 30 * DAY });
    stripe.delay = 6;
    await Promise.all([
      deliver('checkout.session.completed', sessionFor(a, `sub_raceA${round}`)),
      deliver('checkout.session.completed', sessionFor(b, `sub_raceB${round}`)),
    ]);
    stripe.delay = 0;
    const statuses = [
      (await db.purchaseById(a.body.get('metadata[purchase_id]'))).status,
      (await db.purchaseById(b.body.get('metadata[purchase_id]'))).status,
    ].sort();
    assert.deepEqual(statuses, ['paid', 'refunded_conflict'], `round ${round}`);
    const cancelled = [stripe.subs.get(`sub_raceA${round}`).status, stripe.subs.get(`sub_raceB${round}`).status].sort();
    assert.deepEqual(cancelled, ['active', 'canceled'], `round ${round}`);
  }
});

test('6: money lands on a row whose checkout completion never arrived: the row is settled from the session', async () => {
  await free('L5');
  const s = await startCheckout('L5');
  const pid = s.body.get('metadata[purchase_id]');
  addSub('sub_lost1', { start: Date.now(), end: Date.now() + 30 * DAY });
  stripe.sessionObjs.set(s.id, sessionFor(s, 'sub_lost1'));
  // checkout.session.completed is never delivered; only the invoice.
  await deliver('invoice.paid', invoice('in_lost1_1', 'sub_lost1', Date.now(), Date.now() + 30 * DAY, { reason: 'subscription_create', meta: { purchase_id: pid } }));
  const row = await db.purchaseById(pid);
  assert.equal(row.status, 'paid');
  assert.equal(row.stripe_subscription_id, 'sub_lost1');
  assert.ok(toBuyer().some((m) => /card details/.test(m.subject)), 'the buyer gets the details link');

  // A hold whose session cannot be settled and keeps getting billed: Rob is told.
  await free('L5');
  const s2 = await startCheckout('L5');
  const pid2 = s2.body.get('metadata[purchase_id]');
  addSub('sub_lost2', { start: Date.now(), end: Date.now() + 30 * DAY });
  mails.length = 0;
  await deliver('invoice.paid', invoice('in_lost2_2', 'sub_lost2', Date.now(), Date.now() + 30 * DAY, { meta: { purchase_id: pid2 } }));
  assert.equal((await db.purchaseById(pid2)).status, 'hold');
  assert.ok(toRob().some((m) => /never checked in/.test(m.subject)));
});

test('5: a renewal and a subscription update landing together, or out of order, leave the right end', async () => {
  const row = await subscribeAndApprove('L1', 'sub_conc1');
  const sub = stripe.subs.get('sub_conc1');
  // The renewal failed: the card is on the week's hold.
  sub.status = 'past_due';
  await deliver('customer.subscription.updated', structuredClone(sub));
  // The retry pays: Stripe sends invoice.paid and updated(active) at once.
  sub.status = 'active';
  setPeriod('sub_conc1', row.paid_through, row.paid_through + 30 * DAY);
  stripe.delay = 6;
  await Promise.all([
    deliver('invoice.paid', invoice('in_conc1_2', 'sub_conc1', row.paid_through, row.paid_through + 30 * DAY)),
    deliver('customer.subscription.updated', structuredClone(sub)),
  ]);
  stripe.delay = 0;
  const after1 = await db.purchaseById(row.id);
  assert.equal(after1.paid_through, row.paid_through + 30 * DAY);
  assert.equal(after1.ends_at, after1.paid_through + row.shift_ms + sponsors.RENEWAL_GRACE_MS);
  // A stale past_due payload arriving last is read fresh from Stripe: still active.
  await deliver('customer.subscription.updated', { ...structuredClone(sub), status: 'past_due' });
  assert.equal((await db.purchaseById(row.id)).ends_at, after1.ends_at);
});

test('4: duplicate deliveries of a hand-issued link and an admin attach at once make exactly one row', async () => {
  await free('L2');
  addSub('sub_duplicate1', { start: Date.now(), end: Date.now() + 30 * DAY, email: 'dup@example.test' });
  const session = {
    id: 'cs_dup1', mode: 'subscription', payment_status: 'paid', subscription: 'sub_duplicate1', invoice: 'in_sub_duplicate1_1',
    amount_total: 100000, metadata: { kind: 'sponsor_subscription_manual', slot_id: 'L2' }, customer_details: { email: 'dup@example.test' },
  };
  stripe.delay = 6;
  await Promise.all([
    deliver('checkout.session.completed', session),
    deliver('checkout.session.completed', session),
    adminPost({ action: 'attach', subscription: 'sub_duplicate1', slot: 'L2' }),
  ]);
  stripe.delay = 0;
  const rows = (await db.activePurchases()).filter((p) => p.slot_id === 'L2');
  assert.equal(rows.length, 1, 'one row, no orphan blocking the slot');
  assert.equal(rows[0].stripe_subscription_id, 'sub_duplicate1');
  assert.equal(rows[0].status, 'paid');
});

test('a hand-issued link with no slot alerts Rob, then attaches from the admin page; refusals are clean', async () => {
  await free('L5');
  addSub('sub_manual1', { start: Date.now(), end: Date.now() + 30 * DAY, email: 'manual@example.test' });
  await deliver('checkout.session.completed', {
    id: 'cs_manual1', mode: 'subscription', payment_status: 'paid', subscription: 'sub_manual1', invoice: 'in_sub_manual1_1',
    amount_total: 100000, metadata: { kind: 'sponsor_subscription_manual' }, customer_details: { email: 'manual@example.test' },
  });
  assert.equal(await db.purchaseBySubscription('sub_manual1'), null, 'no slot named, nothing recorded');
  assert.ok(toRob().some((m) => /attach it/.test(m.subject)));
  await deliver('invoice.paid', invoice('in_sub_manual1_x', 'sub_manual1', Date.now(), Date.now() + 30 * DAY, { reason: 'subscription_create', meta: { kind: 'sponsor_subscription_manual' } }));

  const res = await adminPost({ action: 'attach', subscription: 'sub_manual1', slot: 'L5' });
  assert.equal(res.status, 200);
  const row = await db.purchaseBySubscription('sub_manual1');
  assert.equal(row.slot_id, 'L5');
  assert.equal(row.status, 'paid');
  assert.equal(row.email, 'manual@example.test');
  assert.ok(toBuyer().some((m) => m.to === 'manual@example.test' && /card details/.test(m.subject)));
  assert.equal((await adminPost({ action: 'attach', subscription: 'sub_manual1', slot: 'L5' })).status, 409);
  addSub('sub_manual2', { start: Date.now(), end: Date.now() + 30 * DAY });
  assert.equal((await adminPost({ action: 'attach', subscription: 'sub_manual2', slot: 'L5' })).status, 409, 'slot taken');
  assert.equal((await adminPost({ action: 'attach', subscription: 'not-a-sub', slot: 'L3' })).status, 409);
  // A paid link naming a taken slot records nothing and tells Rob why.
  mails.length = 0;
  await deliver('checkout.session.completed', {
    id: 'cs_manual2', mode: 'subscription', payment_status: 'paid', subscription: 'sub_manual2', invoice: 'in_sub_manual2_1',
    amount_total: 100000, metadata: { kind: 'sponsor_subscription_manual', slot_id: 'L5' }, customer_details: { email: 'x@example.test' },
  });
  assert.equal(await db.purchaseBySubscription('sub_manual2'), null);
  assert.ok(toRob().some((m) => /attach it/.test(m.subject) && /taken/.test(m.html)));
});

test('9d: a subscription link carrying a one-off purpose never gets a one-off row', async () => {
  await free('L3');
  addSub('sub_purpose1', { start: Date.now(), end: Date.now() + 30 * DAY });
  await deliver('checkout.session.completed', {
    id: 'cs_purp1', mode: 'subscription', payment_status: 'paid', subscription: 'sub_purpose1', amount_total: 100000,
    metadata: { kind: 'sponsor_subscription_manual', slot_id: 'L3', purpose: 'sponsor_public_2026_11' },
  });
  const row = await db.purchaseBySubscription('sub_purpose1');
  assert.equal(row?.slot_id, 'L3', 'with a sponsor kind it takes the subscription path');
  assert.equal(await db.purchaseBySession('cs_purp1'), null);
  addSub('sub_purpose2', { start: Date.now(), end: Date.now() + 30 * DAY });
  mails.length = 0;
  await deliver('checkout.session.completed', {
    id: 'cs_purp2', mode: 'subscription', payment_status: 'paid', subscription: 'sub_purpose2', amount_total: 100000,
    metadata: { slot_id: 'L3', purpose: 'sponsor_public_2026_11' },
  });
  assert.equal(await db.purchaseBySession('cs_purp2'), null);
  assert.ok(toRob().some((m) => /one-off purpose/.test(m.subject)));
});

test('8: refunding falls back to the subscription\'s latest invoice when the row has none', async () => {
  addSub('sub_noinv1', { start: Date.now(), end: Date.now() + 30 * DAY });
  stripe.refunds.length = 0;
  await subs.cancelAndRefund({ id: 'p-noinv', stripe_subscription_id: 'sub_noinv1', stripe_invoice_id: null });
  assert.deepEqual(stripe.refunds.map((r) => r.payment_intent), ['pi_sub_noinv1_1']);
  assert.equal(stripe.subs.get('sub_noinv1').status, 'canceled');
});

test('1: a handler that throws answers 500 and alerts Rob once; the redelivery then applies', async () => {
  const row = await subscribeAndApprove('L2', 'sub_throw1');
  const inv = invoice('in_throw1_2', 'sub_throw1', row.paid_through, row.paid_through + 30 * DAY);
  const id = `evt_${crypto.randomUUID()}`;
  mails.length = 0;
  await failWritesFor(row.id);
  try {
    await deliver('invoice.paid', inv, { expect: 500, id });
    assert.equal(toRob().filter((m) => /webhook FAILED/.test(m.subject)).length, 1);
    await deliver('invoice.paid', inv, { expect: 500, id });
    assert.equal(toRob().filter((m) => /webhook FAILED/.test(m.subject)).length, 1, 'once per event, not per retry');
  } finally {
    await healWrites();
  }
  await deliver('invoice.paid', inv, { id });
  assert.equal((await db.purchaseById(row.id)).paid_through, row.paid_through + 30 * DAY);
});

test('a one-off payment session still follows the old path', async () => {
  await free('L4');
  const pid = crypto.randomUUID();
  await db.insertPurchase({ id: pid, slot_id: 'L4', status: 'hold', amount_cents: 250000, months: 1, details_token: sponsors.newToken(), created_at: Date.now(), hold_expires_at: Date.now() + 1000 });
  await deliver('checkout.session.completed', {
    id: 'cs_oneoff', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_oneoff', amount_total: 250000,
    metadata: { purchase_id: pid }, customer_details: { email: 'o@example.test' },
  });
  const row = await db.purchaseById(pid);
  assert.equal(row.status, 'paid');
  assert.equal(row.stripe_payment_intent, 'pi_oneoff');
  assert.equal(row.stripe_subscription_id, null);
});
