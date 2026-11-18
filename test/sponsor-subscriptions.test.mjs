/* Sponsor subscriptions: checkout in subscription mode, the first payment,
   approval, renewals, a failed renewal, a late payment, cancellation, the
   sponsor's own cancel button, and attaching a subscription paid through a
   hand-issued link. Runs against a throwaway SQLite database and a fake
   Stripe (and a fake mail API) behind globalThis.fetch. Run: npm test */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dir = mkdtempSync(path.join(tmpdir(), 'cvci-subs-'));
// Postgres too, when pointed at a throwaway database (production runs Postgres):
// SUBS_TEST_DATABASE_URL=postgres://... npm test
if (process.env.SUBS_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.SUBS_TEST_DATABASE_URL;
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

/* ---------- fake Stripe + mail ---------- */

const stripe = { subs: new Map(), invoices: new Map(), customers: new Map(), calls: [], refunds: [], sessions: [] };
const mails = [];

function fakeFetch(url, init = {}) {
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
  stripe.calls.push({ method, path: u.pathname, body });
  let m;
  if (u.pathname === '/v1/checkout/sessions' && method === 'POST') {
    const s = { id: `cs_test_${stripe.sessions.length + 1}`, url: 'https://checkout.stripe.test/s', body };
    stripe.sessions.push(s);
    return ok(s);
  }
  if ((m = /^\/v1\/subscriptions\/([^/]+)$/.exec(u.pathname))) {
    const sub = stripe.subs.get(m[1]);
    if (!sub) return nope('No such subscription');
    if (method === 'GET') return ok(sub);
    if (method === 'DELETE') {
      if (sub.status === 'canceled') return nope('This subscription has already been canceled', 400);
      sub.status = 'canceled';
      return ok(sub);
    }
    if (method === 'POST') {
      if (body.has('cancel_at_period_end')) sub.cancel_at_period_end = body.get('cancel_at_period_end') === 'true';
      return ok(sub);
    }
  }
  if ((m = /^\/v1\/invoices\/([^/]+)$/.exec(u.pathname))) {
    const inv = stripe.invoices.get(m[1]);
    return inv ? ok(inv) : nope('No such invoice');
  }
  if ((m = /^\/v1\/customers\/([^/]+)$/.exec(u.pathname))) {
    return ok(stripe.customers.get(m[1]) ?? { id: m[1], email: null });
  }
  if (u.pathname === '/v1/refunds' && method === 'POST') {
    stripe.refunds.push(Object.fromEntries(body.entries()));
    return ok({ id: `re_${stripe.refunds.length}`, status: 'succeeded' });
  }
  if (u.pathname === '/v1/refunds' && method === 'GET') return ok({ data: [] });
  return nope(`unhandled ${method} ${u.pathname}`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => fakeFetch(String(url), init);

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
  stripe.invoices.set(`in_${id}_1`, { id: `in_${id}_1`, payment_intent: `pi_${id}_1` });
  return sub;
}

// A renewal invoice in either API shape.
function invoice(id, subId, start, end, { newShape = true, reason = 'subscription_cycle', meta = {} } = {}) {
  const inv = {
    id, object: 'invoice', billing_reason: reason, amount_paid: 100000,
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
  mails.length = 0;
  sponsors.clearCache();
});

const freshIp = () => `10.0.0.${++ipSeq}`;
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

async function deliver(type, object) {
  const raw = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  const res = await webhook.POST({
    request: new Request('https://example.test/api/sponsor/webhook', {
      method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: raw,
    }),
  });
  assert.equal(res.status, 200);
}

const adminPost = (fields) => admin.POST({ request: jsonReq('/api/sponsor/admin', { token: process.env.ADMIN_TOKEN, ...fields }) });

/* Checkout → paid → details → approved, through the real endpoints. */
async function subscribeAndApprove(slot, subId, { paidAt = Date.now() } = {}) {
  const res = await checkout.POST({ request: formReq('/api/sponsor/checkout', { slot }), clientAddress: '10.9.9.9' });
  assert.equal(res.status, 303);
  const session = stripe.sessions.at(-1);
  const purchaseId = session.body.get('metadata[purchase_id]');
  addSub(subId, { start: paidAt, end: paidAt + 30 * DAY });
  await deliver('checkout.session.completed', {
    id: session.id, mode: 'subscription', payment_status: 'paid', payment_intent: null,
    subscription: subId, invoice: `in_${subId}_1`, amount_total: 100000,
    client_reference_id: purchaseId, metadata: { purchase_id: purchaseId, slot_id: slot, kind: 'sponsor_slot' },
    customer_details: { email: 'buyer@example.test' },
  });
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

/* ---------- pure parts ---------- */

test('one price, from config, with a safe default', () => {
  assert.equal(sponsors.sponsorPriceCents({}), 100000);
  assert.equal(sponsors.sponsorPriceCents({ SPONSOR_PRICE_CENTS: '125000' }), 125000);
  assert.equal(sponsors.sponsorPriceCents({ SPONSOR_PRICE_CENTS: 'abc' }), 100000);
  assert.equal(sponsors.sponsorPriceCents({ SPONSOR_PRICE_CENTS: '12.5' }), 100000);
  assert.equal(sponsors.sponsorPriceCents({ SPONSOR_PRICE_CENTS: '0' }), 100000);
});

test('term arithmetic: approval counts from approval, grace only while renewing', () => {
  const paidAt = Date.UTC(2026, 10, 1);
  const p = { paid_at: paidAt, paid_through: paidAt + 30 * DAY };
  const t = sponsors.approvalTerm(p, paidAt + 6 * 60 * 60 * 1000);
  assert.equal(t.shift_ms, 6 * 60 * 60 * 1000);
  assert.equal(t.ends_at, paidAt + 30 * DAY + t.shift_ms + sponsors.RENEWAL_GRACE_MS);
  assert.equal(sponsors.paidEndAt({ ...p, ...t }), paidAt + 30 * DAY + t.shift_ms);
  const cancelled = sponsors.approvalTerm({ ...p, cancel_at: paidAt + 30 * DAY }, paidAt);
  assert.equal(cancelled.ends_at, paidAt + 30 * DAY);
  assert.equal(sponsors.subscriptionEndsAt({ paidThrough: null }), null);
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

test('first payment, details, approval: the card runs a month from approval and renews', async () => {
  const paidAt = Date.now() - 2 * 60 * 60 * 1000;
  const row = await subscribeAndApprove('L1', 'sub_life1', { paidAt });
  assert.equal(row.status, 'live');
  assert.equal(row.stripe_subscription_id, 'sub_life1');
  assert.equal(row.paid_through, sec(paidAt + 30 * DAY) * 1000);
  assert.ok(row.shift_ms >= 2 * 60 * 60 * 1000 - 5000, 'approval delay is given back');
  assert.equal(row.ends_at, row.paid_through + row.shift_ms + sponsors.RENEWAL_GRACE_MS);
  assert.ok(mails.some((m) => m.subject === "you're live on canivibecodeit" && m.html.includes('/sponsor/stats?t=')));
  const board = await sponsors.getBoard();
  assert.equal(board.slots.find((s) => s.id === 'L1').state, 'live');

  // A renewal extends the run by the new period; the same event again changes nothing.
  const next = invoice('in_life1_2', 'sub_life1', row.paid_through, row.paid_through + 31 * DAY);
  await deliver('invoice.paid', next);
  const renewed = await db.purchaseById(row.id);
  assert.equal(renewed.paid_through, row.paid_through + 31 * DAY);
  assert.equal(renewed.ends_at, renewed.paid_through + row.shift_ms + sponsors.RENEWAL_GRACE_MS);
  assert.equal(renewed.stripe_invoice_id, 'in_life1_2');
  await deliver('invoice.paid', next);
  assert.equal((await db.purchaseById(row.id)).ends_at, renewed.ends_at);
});

test('the old invoice shape renews too', async () => {
  const row = await subscribeAndApprove('L2', 'sub_old1');
  await deliver('invoice.paid', invoice('in_old1_2', 'sub_old1', row.paid_through, row.paid_through + 30 * DAY, { newShape: false }));
  assert.equal((await db.purchaseById(row.id)).paid_through, row.paid_through + 30 * DAY);
});

test('a failed renewal ends the card at the end of the paid period, once', async () => {
  const row = await subscribeAndApprove('L3', 'sub_fail1');
  const failed = invoice('in_fail1_2', 'sub_fail1', row.paid_through, row.paid_through + 30 * DAY);
  await deliver('invoice.payment_failed', failed);
  const after1 = await db.purchaseById(row.id);
  assert.equal(after1.ends_at, row.paid_through + row.shift_ms, 'grace dropped, paid time kept');
  const sentFirst = mails.length;
  assert.ok(mails.some((m) => m.subject === 'your canivibecodeit renewal did not go through' && m.html.includes('invoice.stripe.test')));
  await deliver('invoice.payment_failed', failed);
  assert.equal(mails.length, sentFirst, 'a retry that fails again sends nothing new');
});

test('a failed renewal still emails when past_due arrives before the failure event', async () => {
  const row = await subscribeAndApprove('R5', 'sub_fail2');
  const sub = stripe.subs.get('sub_fail2');
  sub.status = 'past_due';
  await deliver('customer.subscription.updated', sub);
  assert.equal((await db.purchaseById(row.id)).ends_at, row.paid_through + row.shift_ms);
  mails.length = 0;
  await deliver('invoice.payment_failed', invoice('in_fail2_2', 'sub_fail2', row.paid_through, row.paid_through + 30 * DAY));
  assert.ok(mails.some((m) => m.subject === 'your canivibecodeit renewal did not go through'));
  assert.ok(mails.some((m) => m.to === 'rob@example.test' && /renewal FAILED/.test(m.subject)));
  const n = mails.length;
  await deliver('invoice.payment_failed', invoice('in_fail2_2', 'sub_fail2', row.paid_through, row.paid_through + 30 * DAY));
  assert.equal(mails.length, n, 'a retry that fails again sends nothing new');
  // Free R5 again for the race test below.
  await db.updatePurchase(row.id, { status: 'expired', ends_at: Date.now() - 1 });
});

test('a late payment puts the card back when the slot is still free', async () => {
  const paidAt = Date.now() - 31 * DAY;
  const row = await subscribeAndApprove('L4', 'sub_late1', { paidAt });
  // Approval happened "now", so move the term into the past by hand: the
  // paid period ended yesterday and the renewal failed.
  await db.updatePurchase(row.id, { paid_through: Date.now() - DAY, shift_ms: 0, ends_at: Date.now() - DAY });
  sponsors.clearCache();
  assert.equal((await sponsors.getBoard()).slots.find((s) => s.id === 'L4').state, 'open');
  await deliver('invoice.paid', invoice('in_late1_2', 'sub_late1', Date.now() - DAY, Date.now() + 29 * DAY));
  const back = await db.purchaseById(row.id);
  assert.equal(back.status, 'live');
  assert.ok(back.ends_at > Date.now() + 29 * DAY);
  assert.equal((await sponsors.getBoard()).slots.find((s) => s.id === 'L4').state, 'live');
});

test('a late payment on a slot taken meanwhile is refunded and the subscription stopped', async () => {
  const row = await subscribeAndApprove('R1', 'sub_late2');
  await db.updatePurchase(row.id, { paid_through: Date.now() - 2 * DAY, shift_ms: 0, ends_at: Date.now() - 2 * DAY, status: 'expired' });
  await subscribeAndApprove('R1', 'sub_newcomer');
  stripe.refunds.length = 0;
  await deliver('invoice.paid', invoice('in_late2_2', 'sub_late2', Date.now() - 2 * DAY, Date.now() + 28 * DAY));
  const after1 = await db.purchaseById(row.id);
  assert.equal(after1.status, 'expired');
  assert.ok(after1.canceled_at);
  assert.equal(stripe.subs.get('sub_late2').status, 'canceled');
  assert.deepEqual(stripe.refunds, [{ payment_intent: 'pi_in_late2_2' }]);
});

test('cancelling keeps the paid time, drops the grace, then ends', async () => {
  const row = await subscribeAndApprove('R2', 'sub_cancel1');
  const sub = stripe.subs.get('sub_cancel1');
  sub.cancel_at_period_end = true;
  await deliver('customer.subscription.updated', sub);
  const c = await db.purchaseById(row.id);
  assert.ok(c.cancel_at);
  assert.equal(c.ends_at, row.paid_through + row.shift_ms);
  assert.ok(mails.some((m) => m.subject === 'cancelled · your sponsor card will not renew'));
  // Un-cancelled from the dashboard: the grace comes back.
  sub.cancel_at_period_end = false;
  await deliver('customer.subscription.updated', sub);
  assert.equal((await db.purchaseById(row.id)).ends_at, row.ends_at);
  // Deleted: billing stopped, the card keeps what was paid.
  sub.status = 'canceled';
  await deliver('customer.subscription.deleted', sub);
  const d = await db.purchaseById(row.id);
  assert.ok(d.canceled_at);
  assert.equal(d.ends_at, row.paid_through + row.shift_ms);
  assert.equal(d.status, 'live', 'still up until the paid period ends');
});

test("the sponsor's cancel button stops renewal through Stripe", async () => {
  const row = await subscribeAndApprove('R3', 'sub_self1');
  const res = await cancel.POST({ request: formReq('/api/sponsor/cancel', { t: row.details_token }), clientAddress: '2.2.2.2' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /msg=cancelled/);
  assert.ok(stripe.calls.some((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_self1' && c.body.get('cancel_at_period_end') === 'true'));
  const c = await db.purchaseById(row.id);
  assert.ok(c.cancel_at);
  assert.equal(c.ends_at, row.paid_through + row.shift_ms);
  const again = await cancel.POST({ request: formReq('/api/sponsor/cancel', { t: row.details_token }), clientAddress: '2.2.2.2' });
  assert.match(again.headers.get('location'), /already%20cancelled/);
  const bad = await cancel.POST({ request: formReq('/api/sponsor/cancel', { t: 'nope' }), clientAddress: '2.2.2.2' });
  assert.equal(bad.status, 404);
});

test('reject stops billing and refunds; take-down stops billing', async () => {
  // Reject before approval.
  const res = await checkout.POST({ request: formReq('/api/sponsor/checkout', { slot: 'R4' }), clientAddress: '3.3.3.3' });
  assert.equal(res.status, 303);
  const s = stripe.sessions.at(-1);
  const pid = s.body.get('metadata[purchase_id]');
  addSub('sub_rej1', { start: Date.now(), end: Date.now() + 30 * DAY });
  await deliver('checkout.session.completed', {
    id: s.id, mode: 'subscription', payment_status: 'paid', subscription: 'sub_rej1', invoice: 'in_sub_rej1_1',
    amount_total: 100000, metadata: { purchase_id: pid }, customer_details: { email: 'r@example.test' },
  });
  const r = await adminPost({ action: 'reject', id: pid });
  assert.equal(r.status, 200);
  assert.equal((await db.purchaseById(pid)).status, 'rejected');
  assert.equal(stripe.subs.get('sub_rej1').status, 'canceled');
  assert.deepEqual(stripe.refunds.at(-1), { payment_intent: 'pi_sub_rej1_1' });
  // The deletion event that follows is a no-op.
  const before1 = mails.length;
  await deliver('customer.subscription.deleted', stripe.subs.get('sub_rej1'));
  assert.equal(mails.length, before1);

  // Take down a live one.
  const live = await subscribeAndApprove('R4', 'sub_down1');
  const d = await adminPost({ action: 'expire', id: live.id });
  assert.equal(d.status, 200);
  const down = await db.purchaseById(live.id);
  assert.equal(down.status, 'expired');
  assert.ok(down.canceled_at);
  assert.equal(stripe.subs.get('sub_down1').status, 'canceled');
});

test('two subscribers racing for one slot: the second is refunded and stopped', async () => {
  const a = await checkout.POST({ request: formReq('/api/sponsor/checkout', { slot: 'R5' }), clientAddress: '4.4.4.4' });
  const sa = stripe.sessions.at(-1);
  const b = await checkout.POST({ request: formReq('/api/sponsor/checkout', { slot: 'R5' }), clientAddress: '4.4.4.5' });
  const sb = stripe.sessions.at(-1);
  assert.equal(a.status, 303);
  assert.equal(b.status, 303);
  addSub('sub_raceA', { start: Date.now(), end: Date.now() + 30 * DAY });
  addSub('sub_raceB', { start: Date.now(), end: Date.now() + 30 * DAY });
  const done = (s, sub) => deliver('checkout.session.completed', {
    id: s.id, mode: 'subscription', payment_status: 'paid', subscription: sub, invoice: `in_${sub}_1`, amount_total: 100000,
    metadata: { purchase_id: s.body.get('metadata[purchase_id]') }, customer_details: { email: `${sub}@example.test` },
  });
  await done(sa, 'sub_raceA');
  await new Promise((r) => setTimeout(r, 5));
  await done(sb, 'sub_raceB');
  assert.equal((await db.purchaseById(sa.body.get('metadata[purchase_id]'))).status, 'paid');
  assert.equal((await db.purchaseById(sb.body.get('metadata[purchase_id]'))).status, 'refunded_conflict');
  assert.equal(stripe.subs.get('sub_raceB').status, 'canceled');
  assert.equal(stripe.subs.get('sub_raceA').status, 'active');
});

test('a hand-issued subscription link: alert, then attach to a slot as a new card', async () => {
  // Free a slot for it: L5's earlier hold never paid.
  addSub('sub_manual1', { start: Date.now(), end: Date.now() + 30 * DAY, email: 'manual@example.test' });
  await deliver('checkout.session.completed', {
    id: 'cs_manual1', mode: 'subscription', payment_status: 'paid', subscription: 'sub_manual1', invoice: 'in_sub_manual1_1',
    amount_total: 100000, metadata: { kind: 'sponsor_subscription_manual' }, customer_details: { email: 'manual@example.test' },
  });
  assert.equal(await db.purchaseBySubscription('sub_manual1'), null, 'no slot named, nothing recorded');
  assert.ok(mails.some((m) => m.to === 'rob@example.test' && /attach it/.test(m.subject)));
  // Its invoice before attaching is ignored without error.
  await deliver('invoice.paid', invoice('in_sub_manual1_x', 'sub_manual1', Date.now(), Date.now() + 30 * DAY, { reason: 'subscription_create', meta: { kind: 'sponsor_subscription_manual' } }));

  const res = await adminPost({ action: 'attach', subscription: 'sub_manual1', slot: 'L5', carry: '0' });
  assert.equal(res.status, 200);
  const row = await db.purchaseBySubscription('sub_manual1');
  assert.equal(row.slot_id, 'L5');
  assert.equal(row.status, 'paid');
  assert.equal(row.email, 'manual@example.test');
  assert.ok(mails.some((m) => m.to === 'manual@example.test' && /card details/.test(m.subject)));
  // Attaching twice, or to a taken slot, is refused.
  const twice = await adminPost({ action: 'attach', subscription: 'sub_manual1', slot: 'L5' });
  assert.equal(twice.status, 409);
  addSub('sub_manual2', { start: Date.now(), end: Date.now() + 30 * DAY });
  const taken = await adminPost({ action: 'attach', subscription: 'sub_manual2', slot: 'L5' });
  assert.equal(taken.status, 409);
  const bogus = await adminPost({ action: 'attach', subscription: 'not-a-sub', slot: 'L2' });
  assert.equal(bogus.status, 409);
});

test("attach with carry: the slot's one-off card continues as a subscription after its run", async () => {
  // A legacy one-off run in a fresh slot id is not possible (ten slots), so
  // reuse L2 after freeing it.
  for (const p of await db.activePurchases()) if (p.slot_id === 'L2') await db.updatePurchase(p.id, { status: 'expired', ends_at: Date.now() - 1 });
  const legacy = { id: crypto.randomUUID(), slot_id: 'L2', status: 'live', amount_cents: 250000, months: 1, details_token: sponsors.newToken(), created_at: Date.now(), hold_expires_at: null };
  await db.insertPurchase(legacy);
  const runEnd = Date.now() + 10 * DAY;
  await db.updatePurchase(legacy.id, { name: 'Legacy Co', tagline: 'Old run', url: 'https://legacy.test/', email: 'l@example.test', starts_at: Date.now() - 20 * DAY, ends_at: runEnd, approved_at: Date.now() - 20 * DAY });
  sponsors.clearCache();

  const now = Date.now();
  addSub('sub_carry1', { start: now, end: now + 30 * DAY, email: 'l@example.test' });
  const res = await adminPost({ action: 'attach', subscription: 'sub_carry1', slot: 'L2', carry: '1' });
  assert.equal(res.status, 200);
  const row = await db.purchaseBySubscription('sub_carry1');
  assert.equal(row.status, 'live');
  assert.equal(row.name, 'Legacy Co');
  assert.equal(row.starts_at, runEnd, 'the paid month starts when the current run ends');
  assert.ok(Math.abs(sponsors.paidEndAt(row) - (runEnd + 30 * DAY)) < 2000);
  const board = await sponsors.getBoard();
  assert.equal(board.slots.find((s) => s.id === 'L2').sponsor.name, 'Legacy Co');
});

test('a one-off payment session still follows the old path', async () => {
  const pid = crypto.randomUUID();
  await db.insertPurchase({ id: pid, slot_id: 'L3', status: 'hold', amount_cents: 250000, months: 1, details_token: sponsors.newToken(), created_at: Date.now(), hold_expires_at: Date.now() + 1000 });
  for (const p of await db.activePurchases()) if (p.slot_id === 'L3' && p.id !== pid) await db.updatePurchase(p.id, { status: 'expired', ends_at: Date.now() - 1 });
  await deliver('checkout.session.completed', {
    id: 'cs_oneoff', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_oneoff', amount_total: 250000,
    metadata: { purchase_id: pid }, customer_details: { email: 'o@example.test' },
  });
  const row = await db.purchaseById(pid);
  assert.equal(row.status, 'paid');
  assert.equal(row.stripe_payment_intent, 'pi_oneoff');
  assert.equal(row.stripe_subscription_id, null);
});
