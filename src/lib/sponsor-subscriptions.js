/* The life of a sponsor subscription after its first payment: renewals extend
   the card, a failed renewal or a cancellation ends it at the end of the paid
   period, and a subscription paid through a hand-issued link can be attached
   to a slot. The term arithmetic lives in sponsors.js ("subscriptions");
   this file applies Stripe's events to the purchase rows.

   Every handler is safe to run twice: Stripe redelivers, and the sponsor's
   own cancel button and the webhook it triggers both land here. */

import crypto from 'node:crypto';
import {
  activePurchases, insertPurchase, purchaseById, purchaseBySubscription, updatePurchase,
} from './db.js';
import { alertRob, brandShell, button, esc, recPs, sendMail, shell } from './mail.js';
import {
  blocksSlot, clearCache, isLive, isSubscription, newToken, paidEndAt, shortDate, siteUrl,
  SLOT_IDS, subscriptionEndsAt, subscriptionRenews, usd,
} from './sponsors.js';
import {
  cancelSubscriptionNow, getCustomer, getSubscription, invoicePeriodEnd, invoiceSubscriptionId,
  invoiceSubscriptionMeta, refundInvoice, subscriptionPeriod,
} from './stripe.js';

const idOf = (v) => (typeof v === 'string' ? v : v?.id ?? null);
const statsLink = (p) => `${siteUrl('/sponsor/stats')}?t=${encodeURIComponent(p.details_token)}`;
const detailsLink = (p) => `${siteUrl('/sponsor/details')}?t=${encodeURIComponent(p.details_token)}`;
const adminLink = () => siteUrl('/admin/sponsors');
const who = (p) => p.name || p.email || p.id;

// Rows whose card is up, or will be once approved.
const PRE_LIVE = ['hold', 'expired_hold', 'paid', 'submitted'];

// Hand-issued links are recognised by their metadata kind; a subscription the
// account sells for anything else never reaches a sponsor row.
export function isSponsorKind(kind) {
  return typeof kind === 'string' && kind.startsWith('sponsor');
}

/* ---------- first payment ---------- */

/* The subscription fields a row takes when its checkout completes. Asks
   Stripe for the period; if that call fails, the first invoice.paid event
   fills it in, and approval falls back to a month from payment. */
export async function subscriptionFieldsFromSession(session, now = Date.now()) {
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
    fields.paid_at = period.start ?? now;
  } catch (err) {
    console.error(`subscription ${subId} lookup failed: ${err?.message || err}`);
  }
  return fields;
}

/* Undo a subscription we will not run: stop the billing first (a refund with
   the billing still on would only be followed by next month's charge), then
   give the latest payment back. Throws with the step that failed. */
export async function cancelAndRefund(purchase, { invoiceId, refundKey } = {}) {
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
  const inv = invoiceId || purchase.stripe_invoice_id;
  if (!inv) throw new Error('no invoice on this purchase to refund');
  await refundInvoice(inv, refundKey || `refund-${purchase.id}-${inv}`);
}

/* ---------- renewals ---------- */

export async function handleInvoicePaid(inv, now = Date.now()) {
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return false;
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

  const fields = { paid_through: periodEnd, stripe_invoice_id: inv.id };
  if (!row.stripe_subscription_id) fields.stripe_subscription_id = subId;

  if (PRE_LIVE.includes(row.status)) {
    // Not running yet: approval counts the term from whatever is paid by then.
    await updatePurchase(row.id, fields);
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

  const endsAt = subscriptionEndsAt({ paidThrough: periodEnd, shiftMs: row.shift_ms, renewing: !row.cancel_at });

  if (row.status === 'live' && row.ends_at > now) {
    await updatePurchase(row.id, { ...fields, ends_at: endsAt }, ['live']);
    clearCache();
    await alertRob(
      `sponsor renewed · ${row.slot_id} ${who(row)} (${usd(inv.amount_paid)})`,
      shell(`<p>${esc(who(row))} renewed slot ${esc(row.slot_id)}. The card now runs until ${esc(shortDate(paidEndAt({ ...row, paid_through: periodEnd })))}.</p>`)
    );
    return true;
  }

  /* The card came down after a failed renewal and a later retry paid. It goes
     back up if nobody has taken the slot since; otherwise the money goes back. */
  const rivals = (await activePurchases()).filter(
    (o) => o.slot_id === row.slot_id && o.id !== row.id && blocksSlot(o, now)
  );
  if (rivals.length === 0) {
    const changed = await updatePurchase(row.id, { ...fields, status: 'live', ends_at: endsAt }, ['live', 'expired']);
    clearCache();
    if (changed) {
      await alertRob(
        `sponsor paid late, card back up · ${row.slot_id} ${who(row)}`,
        shell(`<p>A late renewal for slot ${esc(row.slot_id)} (${esc(who(row))}) went through and the slot was still free, so the card is back up.</p>`)
      );
    }
    return true;
  }

  let failure = null;
  try {
    await cancelAndRefund({ ...row, stripe_invoice_id: inv.id }, { refundKey: `refund-late-${inv.id}` });
  } catch (err) {
    failure = err;
  }
  await updatePurchase(row.id, { ...fields, status: 'expired', canceled_at: now, cancel_at: row.cancel_at ?? now }, ['live', 'expired']);
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

/* A renewal that fails takes the card down at the end of the paid period.
   Stripe retries on its own schedule; a retry that pays lands in
   handleInvoicePaid above. Every failed attempt sends this event again, so the
   emails go out once per paid period (payment_failed_for). The card may
   already be down by then: customer.subscription.updated (past_due) can
   arrive first and drop the grace on its own. */
export async function handleInvoiceFailed(inv, now = Date.now()) {
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return false;
  const row = await purchaseBySubscription(subId);
  if (!row) return false;
  // A first payment fails inside Stripe Checkout, before any card exists.
  if (inv.billing_reason === 'subscription_create') return true;
  if (row.status !== 'live') return true;

  const paidEnd = paidEndAt(row);
  if (!paidEnd) return true;
  const notified = row.payment_failed_for != null && row.payment_failed_for === row.paid_through;
  const fields = {};
  if (row.ends_at > paidEnd) fields.ends_at = paidEnd;
  if (!notified) fields.payment_failed_for = row.paid_through;
  if (Object.keys(fields).length === 0) return true;
  await updatePurchase(row.id, fields, ['live']);
  clearCache();
  if (notified) return true;

  const down = paidEnd <= now;
  await sendMail({
    to: row.email,
    subject: 'your canivibecodeit renewal did not go through',
    html: brandShell(
      `<p>The monthly payment for <b>${esc(row.name || 'your card')}</b> (slot ${esc(row.slot_id)}) failed,`
      + (down ? ' so the card has come down.' : ` so the card comes down on ${esc(shortDate(paidEnd))}.`)
      + '</p>'
      + (inv.hosted_invoice_url
        ? `<p>${button(inv.hosted_invoice_url, 'pay the invoice')}</p>`
          + '<p style="color:#6e6e67; font-size:12px;">Once it is paid, the card goes back up if the slot is still free.</p>'
        : '')
    ),
  });
  await alertRob(
    `sponsor renewal FAILED · ${row.slot_id} ${who(row)}`,
    shell(
      `<p>Invoice <code>${esc(inv.id)}</code> for ${esc(who(row))} (slot ${esc(row.slot_id)}) failed.`
      + ` The card ${down ? 'is down' : `comes down ${esc(shortDate(paidEnd))}`}; Stripe will retry.</p>`
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

/* customer.subscription.updated, and the sponsor's own cancel button. A
   scheduled cancellation drops the renewal grace, so the card ends exactly
   when the paid period does; undoing it puts the grace back. */
export async function applySubscriptionUpdate(sub, now = Date.now()) {
  if (sub?.status === 'canceled') return handleSubscriptionDeleted(sub, now);
  const row = sub?.id ? await purchaseBySubscription(sub.id) : null;
  if (!row || row.canceled_at) return false;

  const ending = scheduledEnd(sub);
  const renews = subscriptionRenews(sub);
  const fields = {};
  if (ending && !row.cancel_at) fields.cancel_at = ending;
  if (!ending && row.cancel_at) fields.cancel_at = null;
  if (row.status === 'live' && row.paid_through) {
    const endsAt = subscriptionEndsAt({ paidThrough: row.paid_through, shiftMs: row.shift_ms, renewing: renews });
    if (endsAt !== row.ends_at) fields.ends_at = endsAt;
  }
  if (Object.keys(fields).length === 0) return true;
  await updatePurchase(row.id, fields);
  clearCache();

  if ('cancel_at' in fields) {
    const until = paidEndAt(row);
    if (fields.cancel_at) {
      await sendMail({
        to: row.email,
        subject: 'cancelled · your sponsor card will not renew',
        html: brandShell(
          `<p>Done. Your subscription for slot ${esc(row.slot_id)} will not renew.`
          + (row.status === 'live' && until ? ` The card stays up until ${esc(shortDate(until))}.` : '')
          + '</p><p style="color:#6e6e67; font-size:12px;">Changed your mind? Reply to this email before then.</p>'
        ),
      });
    }
    await alertRob(
      `sponsor ${fields.cancel_at ? 'cancelled' : 'un-cancelled'} · ${row.slot_id} ${who(row)}`,
      shell(
        `<p>${esc(who(row))} ${fields.cancel_at ? 'will not renew' : 'renews again'} (slot ${esc(row.slot_id)}).`
        + (until ? ` Paid until ${esc(shortDate(until))}.` : '') + '</p>'
      )
    );
  }
  return true;
}

// customer.subscription.deleted: billing has stopped. The card keeps the time
// already paid for and gets no more.
export async function handleSubscriptionDeleted(sub, now = Date.now()) {
  const row = sub?.id ? await purchaseBySubscription(sub.id) : null;
  if (!row || row.canceled_at) return false;
  const fields = { canceled_at: now, cancel_at: row.cancel_at ?? now };
  const paidEnd = paidEndAt(row);
  if (row.status === 'live' && paidEnd && row.ends_at > paidEnd) fields.ends_at = paidEnd;
  await updatePurchase(row.id, fields);
  clearCache();
  const notRunning = PRE_LIVE.includes(row.status);
  await alertRob(
    `sponsor subscription ended · ${row.slot_id} ${who(row)}`,
    shell(
      `<p>Stripe ended subscription <code>${esc(sub.id)}</code> (${esc(who(row))}, slot ${esc(row.slot_id)}, ${esc(row.status)}).`
      + (row.status === 'live' && paidEnd ? ` The card runs until ${esc(shortDate(paidEnd))}.` : '')
      + '</p>'
      + (notRunning
        ? `<p><b>The card never went up.</b> Refund from the <a href="${esc(adminLink())}">admin page</a> (reject) if it should not stand.</p>`
        : '')
    )
  );
  return true;
}

/* ---------- hand-issued subscription links ---------- */

/* Attaches a subscription that was paid outside the site's checkout to a slot,
   so the card follows it from then on.
     carry = false  a new sponsor: the row waits for card details and approval,
                    exactly like a checkout purchase (the buyer is emailed).
     carry = true   the slot's current one-off run continues as a subscription:
                    same card, nothing to approve, and the paid month starts
                    when the current run ends.
   Returns { ok, message, purchase }. */
export async function attachSubscription({ subscriptionId, slotId, carry = false }, now = Date.now()) {
  const subId = String(subscriptionId ?? '').trim();
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

  const actives = await activePurchases();
  const incumbent = actives
    .filter((o) => o.slot_id === slot && isLive(o, now))
    .sort((a, b) => (b.starts_at ?? 0) - (a.starts_at ?? 0))[0];
  if (carry && !incumbent) return { ok: false, message: `nothing running in ${slot} to carry over` };
  if (carry && isSubscription(incumbent)) return { ok: false, message: `${slot} already runs on a subscription` };
  const blockers = actives.filter((o) => o.slot_id === slot && blocksSlot(o, now) && !(carry && o.id === incumbent.id));
  if (blockers.length > 0) return { ok: false, message: `${slot} is taken (${blockers.map((b) => b.status).join(', ')})` };

  let email = null;
  try {
    email = typeof sub.customer === 'object' ? sub.customer?.email : (await getCustomer(sub.customer))?.email;
  } catch (err) {
    console.warn(`customer lookup for ${subId} failed: ${err?.message || err}`);
  }
  const item = sub.items?.data?.[0];
  const amount = item?.price?.unit_amount ?? item?.plan?.amount ?? null;
  const renews = subscriptionRenews(sub);

  const purchase = {
    id: crypto.randomUUID(),
    slot_id: slot,
    status: carry ? 'live' : 'paid',
    amount_cents: amount,
    months: 1,
    details_token: newToken(),
    created_at: now,
    hold_expires_at: null,
  };
  const common = {
    stripe_subscription_id: subId,
    stripe_invoice_id: idOf(sub.latest_invoice),
    paid_through: period.end,
    paid_at: period.start ?? now,
    email: email ?? (carry ? incumbent.email : null),
    cancel_at: scheduledEnd(sub),
  };
  let fields = common;
  if (carry) {
    const startsAt = Math.max(now, incumbent.ends_at);
    const shiftMs = Math.max(0, startsAt - (period.start ?? now));
    fields = {
      ...common,
      name: incumbent.name,
      tagline: incumbent.tagline,
      url: incumbent.url,
      logo_url: incumbent.logo_url,
      tint: incumbent.tint,
      submitted_at: now,
      approved_at: now,
      starts_at: startsAt,
      shift_ms: shiftMs,
      ends_at: subscriptionEndsAt({ paidThrough: period.end, shiftMs, renewing: renews }),
    };
  }
  try {
    await insertPurchase(purchase);
    await updatePurchase(purchase.id, fields);
  } catch (err) {
    console.error(`attach ${subId} failed: ${err?.message || err}`);
    return { ok: false, message: `could not record it: ${err?.message || err}` };
  }
  clearCache();
  const row = await purchaseById(purchase.id);

  if (carry) {
    await sendMail({
      to: row.email,
      subject: `locked in · ${slot} stays yours, monthly`,
      html: brandShell(
        `<p>Payment received. <b>${esc(row.name)}</b> keeps slot ${esc(slot)}: same card, same spot,`
        + ` nothing to do. It renews monthly from ${esc(shortDate(row.starts_at))}.</p>`
        + `<p>Your numbers, and the cancel button: <a href="${esc(statsLink(row))}">your stats page</a>.</p>`
        + recPs('email_sponsor')
      ),
    });
  } else {
    await sendMail({
      to: row.email,
      subject: `you're in · slot ${slot} just needs your card details`,
      html: brandShell(
        `<p>Payment received for slot ${esc(slot)}. One step left: tell us what the card should say.</p>`
        + `<p>${button(detailsLink(row), 'finish your card')}</p>`
        + '<p style="color:#6e6e67; font-size:12px;">Name, one line, and your link. We review every'
        + " placement by hand after that. Keep this email; it's the only copy of your link.</p>"
        + recPs('email_sponsor')
      ),
    });
  }
  await alertRob(
    `subscription attached · ${slot} ${row.name || row.email || ''} (${usd(amount)}/month)`,
    shell(
      `<p>Subscription <code>${esc(subId)}</code> is attached to slot ${esc(slot)}.`
      + (carry
        ? ` The current card carries over and renews from ${esc(shortDate(row.starts_at))}.`
        : ` The buyer was emailed for card details. If that email bounces, their link is: <a href="${esc(detailsLink(row))}">${esc(detailsLink(row))}</a>`)
      + '</p>'
    )
  );
  return { ok: true, message: `${subId} attached to ${slot}${carry ? ', card carried over' : ', waiting on card details'}`, purchase: row };
}

/* checkout.session.completed for a hand-issued subscription link: no purchase
   row exists. A link whose metadata names a slot attaches itself (metadata
   slot_id, and carry=1 to keep the slot's current card); anything else waits
   for Rob on the admin page. */
export async function handleManualSubscriptionSession(session) {
  const meta = session?.metadata || {};
  if (session?.mode !== 'subscription' || meta.purchase_id || !isSponsorKind(meta.kind)) return false;
  const subId = idOf(session.subscription);
  if (session.payment_status !== 'paid' || !subId) return true;
  if (await purchaseBySubscription(subId)) return true;

  const slot = String(meta.slot_id || '').toUpperCase();
  let reason = 'the link names no slot';
  if (SLOT_IDS.includes(slot)) {
    const res = await attachSubscription({ subscriptionId: subId, slotId: slot, carry: meta.carry === '1' });
    if (res.ok) return true;
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
