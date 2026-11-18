/* The life of a sponsor subscription after its first payment: renewals extend
   the card, a failed renewal holds it for a week while Stripe retries, a
   cancellation ends it with the paid period, and a subscription paid through
   a hand-issued link can be attached to a slot. The term arithmetic lives in
   sponsors.js ("subscriptions"); this file applies Stripe's events to the
   purchase rows.

   Concurrency rules, because Stripe sends several events for one change and
   does not promise their order:
   - every handler for one subscription runs behind withSubLock, one at a time
     (one app process serves the site);
   - a card's end is computed in SQL from the row's own paid_through at the
     moment of writing (setEndsFromPaid), never from a value read earlier;
   - paid_through only ever moves forward (guarded update);
   - every email is sent by whichever handler wins a guarded "claim" write, so
     a redelivery or a second event about the same change sends nothing;
   - customer.subscription.updated reads the subscription fresh from Stripe
     rather than trusting a payload that may be older than the last event. */

import crypto from 'node:crypto';
import {
  activePurchases, insertPurchase, purchaseById, purchaseBySubscription, setEndsFromPaid,
  updatePurchase,
} from './db.js';
import { alertRob, brandShell, button, esc, recPs, sendMail, shell } from './mail.js';
import {
  blocksSlot, clearCache, FAILED_HOLD_MS, newToken, paidEndAt, shortDate, siteUrl, SLOT_IDS,
  subscriptionMode, TERM_EXTRA_MS, usd,
} from './sponsors.js';
import {
  cancelSubscriptionNow, getCustomer, getSession, getSubscription, invoiceAlreadyRefunded,
  invoicePeriodEnd, invoiceSubscriptionId, invoiceSubscriptionMeta, listPaidInvoices, refundInvoice,
  subscriptionPeriod,
} from './stripe.js';

const idOf = (v) => (typeof v === 'string' ? v : v?.id ?? null);
const detailsLink = (p) => `${siteUrl('/sponsor/details')}?t=${encodeURIComponent(p.details_token)}`;
const adminLink = () => siteUrl('/admin/sponsors');
const who = (p) => p.name || p.email || p.id;

// Not yet running: awaiting payment confirmation, card details or approval.
const PRE_LIVE = ['hold', 'expired_hold', 'paid', 'submitted'];

// Hand-issued links are recognised by their metadata kind; a subscription the
// account sells for anything else never reaches a sponsor row.
export function isSponsorKind(kind) {
  return typeof kind === 'string' && kind.startsWith('sponsor');
}

/* One subscription's handlers run one at a time. The tail of each chain never
   rejects, so one failure cannot jam the next event. */
const locks = new Map();
export function withSubLock(key, fn) {
  if (!key) return fn();
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/* ---------- first payment ---------- */

/* The subscription fields a row takes when its checkout completes. paid_at is
   NOT taken from Stripe: the double-booking check orders payers by the paid_at
   each promotion stamps itself. If the period lookup fails, the first
   invoice.paid fills paid_through in, and approval falls back to a month. */
export async function subscriptionFieldsFromSession(session) {
  const subId = idOf(session?.subscription);
  if (!subId) return {};
  const fields = {
    stripe_subscription_id: subId,
    stripe_invoice_id: idOf(session.invoice),
    amount_cents: session.amount_total ?? null,
  };
  try {
    const period = subscriptionPeriod(await getSubscription(subId));
    if (period.end) fields.paid_through = period.end;
  } catch (err) {
    console.error(`subscription ${subId} lookup failed: ${err?.message || err}`);
  }
  return fields;
}

/* Undo a subscription we will not run: stop the billing first (a refund with
   the billing still on would only be followed by next month's charge), then
   give the money back.
     allPaid    refund every paid invoice of the subscription (a reject: the
                sponsor is told "refunded in full", so it must be all of it)
     invoiceId  refund that one invoice (a late payment, a lost race)
   With neither, the row's last invoice, else the subscription's latest.
   Throws with the step that failed; safe to run again. */
export async function cancelAndRefund(purchase, { invoiceId, refundKey, allPaid = false, retry = false } = {}) {
  const subId = purchase.stripe_subscription_id;
  if (subId) {
    try {
      await cancelSubscriptionNow(subId);
    } catch (err) {
      // Already cancelled is the state we want.
      if (!/no such subscription|canceled|cancelled/i.test(err?.message || '')) {
        throw new Error(`cancel ${subId}: ${err?.message || err}`);
      }
    }
  }
  const key = refundKey || `refund-${purchase.id}`;
  let invoices;
  if (allPaid && subId) {
    invoices = (await listPaidInvoices(subId)).filter((i) => (i.amount_paid ?? 0) > 0).map((i) => i.id);
  } else {
    let inv = invoiceId || purchase.stripe_invoice_id;
    if (!inv && subId) inv = idOf((await getSubscription(subId)).latest_invoice);
    if (!inv) throw new Error('no invoice on this purchase to refund');
    invoices = [inv];
  }
  for (const inv of invoices) {
    // A retry looks first and uses a fresh key: Stripe replays a stored error
    // for a reused key forever.
    if (retry && (await invoiceAlreadyRefunded(inv))) continue;
    await refundInvoice(inv, retry ? `${key}-${inv}-retry-${Date.now()}` : `${key}-${inv}`);
  }
  return invoices.length;
}

// Marks a row as cancelled by us BEFORE Stripe is told, so the deletion event
// that follows is recognised as ours and raises no alert.
export async function markCancelling(purchase, now = Date.now()) {
  await updatePurchase(purchase.id, { canceled_at: now, cancel_at: purchase.cancel_at ?? now }, null, { isNull: ['canceled_at'] });
}

/* ---------- renewals ---------- */

/* invoice.paid. `promote` is the webhook's promoteFromSession, used when the
   payment lands on a row whose checkout completion we never saw. */
export function handleInvoicePaid(inv, { promote, now = Date.now() } = {}) {
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return false;
  return withSubLock(subId, () => invoicePaid(inv, subId, promote, now));
}

async function invoicePaid(inv, subId, promote, now) {
  const meta = invoiceSubscriptionMeta(inv);
  let row = await purchaseBySubscription(subId);
  // The first invoice can beat checkout.session.completed to us.
  if (!row && meta.purchase_id) row = await purchaseById(meta.purchase_id);
  if (!row) {
    // A hand-issued subscription nobody has attached yet: attaching reads its
    // current period from Stripe, so nothing is lost by waiting.
    if (isSponsorKind(meta.kind)) console.warn(`invoice ${inv.id}: subscription ${subId} not attached to a slot yet`);
    return false;
  }

  const periodEnd = invoicePeriodEnd(inv);
  if (!periodEnd) return true;
  // A redelivery, or an invoice older than one already applied.
  if (row.paid_through && periodEnd <= row.paid_through) return true;

  const fields = { paid_through: periodEnd, stripe_invoice_id: inv.id, stripe_subscription_id: subId };
  const forward = { below: { paid_through: periodEnd } };

  if (row.status === 'hold' || row.status === 'expired_hold') {
    await updatePurchase(row.id, fields, ['hold', 'expired_hold'], forward);
    /* Money arrived on a row still waiting for its checkout completion. It
       usually lands seconds later, but if it was lost the row would stay
       unpaid while Stripe bills every month: settle it from the session. */
    let promoted = false;
    if (promote && row.stripe_session_id) {
      try {
        const session = await getSession(row.stripe_session_id);
        if (session?.status === 'complete' && session.payment_status === 'paid') {
          const after = await promote(session, { notify: true });
          promoted = !!after && !['hold', 'expired_hold'].includes(after.status);
        }
      } catch (err) {
        console.error(`invoice ${inv.id}: session lookup for ${row.id} failed: ${err?.message || err}`);
      }
    }
    if (!promoted && inv.billing_reason !== 'subscription_create') {
      await alertRob(
        `sponsor paid but never checked in · ${row.slot_id}`,
        shell(
          `<p>Invoice <code>${esc(inv.id)}</code> (${usd(inv.amount_paid)}) paid subscription <code>${esc(subId)}</code>,`
          + ` but purchase <code>${esc(row.id)}</code> is still ${esc(row.status)}: its checkout completion never arrived.</p>`
          + `<p>Check it on <a href="${esc(adminLink())}">the admin page</a>.</p>`
        )
      );
    }
    return true;
  }

  if (row.status === 'paid' || row.status === 'submitted') {
    const changed = await updatePurchase(row.id, fields, ['paid', 'submitted'], forward);
    // A month renewed before the card ever went up: the sponsor is paying for
    // a card that is not running yet. Approval counts it in; Rob should know.
    if (changed && inv.billing_reason === 'subscription_cycle') {
      await alertRob(
        `sponsor renewed before the card went up · ${row.slot_id} ${who(row)}`,
        shell(
          `<p>${esc(who(row))} (slot ${esc(row.slot_id)}) paid another month while the card is still ${esc(row.status)}.`
          + ` Approving now gives them every month paid; rejecting refunds all of them.</p>`
          + `<p><a href="${esc(adminLink())}">admin</a></p>`
        )
      );
    }
    return true;
  }

  if ((row.status !== 'live' && row.status !== 'expired') || row.canceled_at) {
    await alertRob(
      `sponsor payment for a card we are not running · ${row.slot_id}`,
      shell(
        `<p>Invoice <code>${esc(inv.id)}</code> (${usd(inv.amount_paid)}) paid subscription`
        + ` <code>${esc(subId)}</code>, whose purchase <code>${esc(row.id)}</code> is ${esc(row.status)}`
        + `${row.canceled_at ? ', cancelled' : ''}.</p>`
        + `<p>Nothing was changed. Refund it from the Stripe dashboard if it should not have been charged.</p>`
      )
    );
    return true;
  }

  const extra = TERM_EXTRA_MS[row.cancel_at ? 'ending' : 'renewing'];

  if (row.status === 'live' && row.ends_at > now) {
    if (!(await updatePurchase(row.id, fields, ['live'], forward))) return true;
    await setEndsFromPaid(row.id, extra, ['live']);
    clearCache();
    await alertRob(
      `sponsor renewed · ${row.slot_id} ${who(row)} (${usd(inv.amount_paid)})`,
      shell(`<p>${esc(who(row))} renewed slot ${esc(row.slot_id)}. The card now runs until ${esc(shortDate(paidEndAt({ ...row, paid_through: periodEnd })))}.</p>`)
    );
    return true;
  }

  /* The card came down (the week's hold ran out) and a later retry paid. It
     goes back up if nobody has taken the slot since; otherwise the money goes
     back and the subscription stops. */
  const rivals = (await activePurchases()).filter(
    (o) => o.slot_id === row.slot_id && o.id !== row.id && blocksSlot(o, now)
  );
  if (rivals.length === 0) {
    if (!(await updatePurchase(row.id, { ...fields, status: 'live' }, ['live', 'expired'], forward))) return true;
    await setEndsFromPaid(row.id, extra, ['live']);
    clearCache();
    await alertRob(
      `sponsor paid late, card back up · ${row.slot_id} ${who(row)}`,
      shell(`<p>A late renewal for slot ${esc(row.slot_id)} (${esc(who(row))}) went through and the slot was still free, so the card is back up.</p>`)
    );
    return true;
  }

  await markCancelling(row, now);
  let failure = null;
  try {
    await cancelAndRefund(row, { invoiceId: inv.id, refundKey: `refund-late-${row.id}` });
  } catch (err) {
    failure = err;
  }
  await updatePurchase(row.id, { ...fields, status: 'expired' }, ['live', 'expired']);
  clearCache();
  if (!failure) {
    await sendMail({
      to: row.email,
      subject: 'your canivibecodeit sponsor slot · refunded',
      html: brandShell(
        `<p>Your renewal for slot ${esc(row.slot_id)} went through after the card had come down,`
        + ` and the slot had been taken in the meantime. We refunded that payment in full and`
        + ` stopped the subscription.</p>`
        + `<p>Another slot may be open: <a href="${esc(siteUrl('/sponsor'))}">${esc(siteUrl('/sponsor'))}</a></p>`
      ),
    });
  }
  await alertRob(
    `late sponsor renewal on a taken slot · ${row.slot_id}${failure ? ' · REFUND FAILED' : ' (refunded)'}`,
    shell(
      `<p>Invoice <code>${esc(inv.id)}</code> (${usd(inv.amount_paid)}) paid late for ${esc(who(row))}, but slot`
      + ` ${esc(row.slot_id)} is held by ${esc(rivals.map((r) => r.id).join(', '))}.</p>`
      + (failure
        ? `<p><b>Cancelling or refunding failed:</b> ${esc(failure?.message || failure)}. Do it from the Stripe dashboard.</p>`
        : '<p>The subscription was cancelled and the payment refunded. Nothing to do.</p>')
    )
  );
  return true;
}

/* invoice.payment_failed on a renewal. The card stays up and the slot stays
   held for FAILED_HOLD_MS past the paid period while Stripe retries; a retry
   that pays lands in handleInvoicePaid. Stripe sends this event again on every
   failed attempt, and customer.subscription.updated (past_due) may arrive
   before it; neither decides the emails. They go out once per paid period, to
   whichever handler claims payment_failed_for. */
export function handleInvoiceFailed(inv, { now = Date.now() } = {}) {
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return false;
  return withSubLock(subId, () => invoiceFailed(inv, subId, now));
}

async function invoiceFailed(inv, subId, now) {
  const row = await purchaseBySubscription(subId);
  if (!row) return false;
  // A first payment fails inside Stripe Checkout, before any card exists.
  if (inv.billing_reason === 'subscription_create') return true;
  if (row.status !== 'live' || !row.paid_through) return true;

  const mode = row.cancel_at ? 'ending' : 'retrying';
  await setEndsFromPaid(row.id, TERM_EXTRA_MS[mode], ['live']);
  clearCache();
  const claimed = await updatePurchase(
    row.id, { payment_failed_for: row.paid_through }, ['live'], { below: { payment_failed_for: row.paid_through } }
  );
  if (!claimed) return true;

  const paidEnd = paidEndAt(row);
  const until = mode === 'retrying' ? paidEnd + FAILED_HOLD_MS : paidEnd;
  const down = until <= now;
  await sendMail({
    to: row.email,
    subject: 'your canivibecodeit renewal did not go through',
    html: brandShell(
      `<p>The monthly payment for <b>${esc(row.name || 'your card')}</b> (slot ${esc(row.slot_id)}) failed.`
      + (down ? ' The card has come down.' : ` The card stays up until ${esc(shortDate(until))} while the payment is retried.`)
      + '</p>'
      + (inv.hosted_invoice_url
        ? `<p>${button(inv.hosted_invoice_url, 'pay the invoice')}</p>`
          + '<p style="color:#6e6e67; font-size:12px;">Pay it before then and nothing changes.</p>'
        : '')
    ),
  });
  await alertRob(
    `sponsor renewal FAILED · ${row.slot_id} ${who(row)}`,
    shell(
      `<p>Invoice <code>${esc(inv.id)}</code> for ${esc(who(row))} (slot ${esc(row.slot_id)}) failed.`
      + ` The card ${down ? 'is down' : `stays up until ${esc(shortDate(until))}`}; Stripe will retry.</p>`
      + `<p><a href="${esc(adminLink())}">admin</a></p>`
    )
  );
  return true;
}

/* ---------- cancellation ---------- */

// When the subscription stops billing, if it has been told to.
function scheduledEnd(sub) {
  if (sub?.cancel_at) return Number(sub.cancel_at) * 1000;
  if (sub?.cancel_at_period_end) return subscriptionPeriod(sub).end;
  return null;
}

/* customer.subscription.updated, and the sponsor's own cancel button. The
   card's extra time follows the subscription's state (subscriptionMode); a
   scheduled cancellation ends the card exactly with the paid period. */
export function applySubscriptionUpdate(payload, { now = Date.now(), fresh = true } = {}) {
  const id = payload?.id;
  if (!id) return false;
  return withSubLock(id, async () => {
    let sub = payload;
    if (fresh) {
      try {
        sub = await getSubscription(id);
      } catch (err) {
        console.warn(`subscription ${id} refetch failed, using the event: ${err?.message || err}`);
      }
    }
    if (sub.status === 'canceled') return subscriptionDeleted(sub, now);
    const row = await purchaseBySubscription(id);
    if (!row || row.canceled_at) return false;

    const ending = scheduledEnd(sub);
    if (row.status === 'live') await setEndsFromPaid(row.id, TERM_EXTRA_MS[subscriptionMode(sub)], ['live']);
    clearCache();

    const until = paidEndAt(row);
    if (ending && !row.cancel_at) {
      const claimed = await updatePurchase(row.id, { cancel_at: ending }, null, { isNull: ['cancel_at'] });
      if (!claimed) return true;
      await sendMail({
        to: row.email,
        subject: 'cancelled · your sponsor card will not renew',
        html: brandShell(
          `<p>Done. Your subscription for slot ${esc(row.slot_id)} will not renew.`
          + (row.status === 'live' && until ? ` The card stays up until ${esc(shortDate(until))}.` : '')
          + '</p><p style="color:#6e6e67; font-size:12px;">Changed your mind? Reply to this email before then.</p>'
        ),
      });
      await alertRob(
        `sponsor cancelled · ${row.slot_id} ${who(row)}`,
        shell(`<p>${esc(who(row))} will not renew (slot ${esc(row.slot_id)}).${until ? ` Paid until ${esc(shortDate(until))}.` : ''}</p>`)
      );
    } else if (!ending && row.cancel_at) {
      const changed = await updatePurchase(row.id, { cancel_at: null }, null, { isNull: ['canceled_at'] });
      if (changed) {
        await alertRob(
          `sponsor un-cancelled · ${row.slot_id} ${who(row)}`,
          shell(`<p>${esc(who(row))} renews again (slot ${esc(row.slot_id)}).</p>`)
        );
      }
    }
    return true;
  });
}

// customer.subscription.deleted: billing has stopped. The card keeps the time
// already paid for and gets nothing more (no grace, no hold).
export function handleSubscriptionDeleted(sub, { now = Date.now() } = {}) {
  if (!sub?.id) return false;
  return withSubLock(sub.id, () => subscriptionDeleted(sub, now));
}

async function subscriptionDeleted(sub, now) {
  const row = await purchaseBySubscription(sub.id);
  if (!row || row.canceled_at) return false;
  // Whoever claims canceled_at speaks; a cancellation we made ourselves
  // claimed it before calling Stripe (markCancelling).
  const claimed = await updatePurchase(row.id, { canceled_at: now, cancel_at: row.cancel_at ?? now }, null, { isNull: ['canceled_at'] });
  if (!claimed) return false;
  if (row.status === 'live') await setEndsFromPaid(row.id, 0, ['live']);
  clearCache();
  if (!['live', 'paid', 'submitted'].includes(row.status)) return true;
  const paidEnd = paidEndAt(row);
  await alertRob(
    `sponsor subscription ended · ${row.slot_id} ${who(row)}`,
    shell(
      `<p>Stripe ended subscription <code>${esc(sub.id)}</code> (${esc(who(row))}, slot ${esc(row.slot_id)}, ${esc(row.status)}).`
      + (row.status === 'live' && paidEnd ? ` The card runs until ${esc(shortDate(paidEnd))}.` : '')
      + '</p>'
      + (row.status !== 'live'
        ? `<p><b>The card never went up.</b> Refund from the <a href="${esc(adminLink())}">admin page</a> (reject) if it should not stand.</p>`
        : '')
    )
  );
  return true;
}

/* ---------- hand-issued subscription links ---------- */

/* Attaches a subscription paid outside the site's checkout to a free slot, so
   the card follows it from then on. The row waits for card details and
   approval exactly like a checkout purchase (the buyer is emailed). The
   subscription id goes in with the INSERT, so the unique index turns a second
   attach of the same subscription (two deliveries, or a delivery racing the
   admin) into a clean refusal instead of a second row.
   Returns { ok, message, purchase }. */
export function attachSubscription({ subscriptionId, slotId }, { now = Date.now() } = {}) {
  const subId = String(subscriptionId ?? '').trim();
  return withSubLock(subId, () => attach(subId, slotId, now));
}

async function attach(subId, slotId, now) {
  const slot = String(slotId ?? '').trim().toUpperCase();
  if (!/^sub_[A-Za-z0-9]{6,}$/.test(subId)) return { ok: false, message: 'that is not a subscription id (sub_…)' };
  if (!SLOT_IDS.includes(slot)) return { ok: false, message: 'unknown slot' };
  const existing = await purchaseBySubscription(subId);
  if (existing) return { ok: false, message: `already attached to ${existing.slot_id}` };

  let sub;
  try {
    sub = await getSubscription(subId);
  } catch (err) {
    return { ok: false, message: `stripe: ${err?.message || err}` };
  }
  if (!['active', 'trialing'].includes(sub.status)) return { ok: false, message: `subscription is ${sub.status}` };
  const period = subscriptionPeriod(sub);
  if (!period.end) return { ok: false, message: 'subscription has no current period' };

  const blockers = (await activePurchases()).filter((o) => o.slot_id === slot && blocksSlot(o, now));
  if (blockers.length > 0) return { ok: false, message: `${slot} is taken (${blockers.map((b) => b.status).join(', ')})` };

  let email = null;
  try {
    email = typeof sub.customer === 'object' ? sub.customer?.email : (await getCustomer(sub.customer))?.email;
  } catch (err) {
    console.warn(`customer lookup for ${subId} failed: ${err?.message || err}`);
  }
  const item = sub.items?.data?.[0];
  const amount = item?.price?.unit_amount ?? item?.plan?.amount ?? null;

  const purchase = {
    id: crypto.randomUUID(),
    slot_id: slot,
    status: 'paid',
    amount_cents: amount,
    months: 1,
    details_token: newToken(),
    created_at: now,
    hold_expires_at: null,
    stripe_subscription_id: subId,
  };
  try {
    await insertPurchase(purchase);
  } catch (err) {
    const again = await purchaseBySubscription(subId).catch(() => null);
    return { ok: false, message: again ? `already attached to ${again.slot_id}` : `could not record it: ${err?.message || err}` };
  }
  try {
    await updatePurchase(purchase.id, {
      stripe_invoice_id: idOf(sub.latest_invoice),
      paid_through: period.end,
      paid_at: period.start ?? now,
      email,
      cancel_at: scheduledEnd(sub),
    });
  } catch (err) {
    // Never leave a half-written row blocking the slot.
    await updatePurchase(purchase.id, { status: 'expired_hold' }).catch(() => {});
    console.error(`attach ${subId} failed: ${err?.message || err}`);
    return { ok: false, message: `could not record it: ${err?.message || err}` };
  }
  clearCache();
  const row = await purchaseById(purchase.id);

  await sendMail({
    to: row.email,
    subject: `you're in · slot ${slot} just needs your card details`,
    html: brandShell(
      `<p>Payment received for slot ${esc(slot)}, billed monthly until you cancel. One step left:`
      + ' tell us what the card should say.</p>'
      + `<p>${button(detailsLink(row), 'finish your card')}</p>`
      + '<p style="color:#6e6e67; font-size:12px;">Name, one line, and your link. We review every'
      + " placement by hand after that. Keep this email; it's the only copy of your link.</p>"
      + recPs('email_sponsor')
    ),
  });
  await alertRob(
    `subscription attached · ${slot} ${row.email || ''} (${usd(amount)}/month)`,
    shell(
      `<p>Subscription <code>${esc(subId)}</code> is attached to slot ${esc(slot)}. The buyer was emailed for`
      + ` card details. If that email bounces, their link is: <a href="${esc(detailsLink(row))}">${esc(detailsLink(row))}</a></p>`
    )
  );
  return { ok: true, message: `${subId} attached to ${slot}, waiting on card details`, purchase: row };
}

/* checkout.session.completed for a hand-issued subscription link: no purchase
   row exists. A link whose metadata names a free slot attaches itself;
   anything else waits for Rob on the admin page. */
export async function handleManualSubscriptionSession(session) {
  const meta = session?.metadata || {};
  if (session?.mode !== 'subscription' || meta.purchase_id || !isSponsorKind(meta.kind)) return false;
  const subId = idOf(session.subscription);
  if (session.payment_status !== 'paid' || !subId) return true;
  if (await purchaseBySubscription(subId)) return true;

  const slot = String(meta.slot_id || '').toUpperCase();
  let reason = 'the link names no slot';
  if (SLOT_IDS.includes(slot)) {
    const res = await attachSubscription({ subscriptionId: subId, slotId: slot });
    if (res.ok) return true;
    // A second delivery of the same payment is not news.
    if (/already attached/.test(res.message)) return true;
    reason = res.message;
  }
  await alertRob(
    `sponsor subscription paid, attach it · ${meta.sponsor || session.customer_details?.email || subId}`,
    shell(
      `<p>A hand-issued sponsor link was paid: subscription <code>${esc(subId)}</code>,`
      + ` ${usd(session.amount_total)}, ${esc(session.customer_details?.email || 'no email')}.`
      + ` It is not on the board yet (${esc(reason)}).</p>`
      + `<p>Attach it to a slot on <a href="${esc(adminLink())}">the admin page</a>.</p>`
    )
  );
  return true;
}
