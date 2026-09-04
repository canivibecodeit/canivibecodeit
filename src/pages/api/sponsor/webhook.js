import crypto from 'node:crypto';
import {
  activePurchases, insertPurchase, purchaseById, purchaseBySession, setSlotNextState,
  updatePurchase,
} from '../../../lib/db.js';
import { recPs, alertAdmin, brandShell, button, esc, sendMail, shell } from '../../../lib/mail.js';
import { json } from '../../../lib/request.js';
import {
  blocksSlot, clearCache, isLive, newToken, RUN_MS, shortDate, siteUrl, SLOT_IDS, SPILL_MS, usd,
} from '../../../lib/sponsors.js';
import { createRefund, verifyStripeSignature } from '../../../lib/stripe.js';

const detailsLink = (purchase) =>
  `${siteUrl('/sponsor/details')}?t=${encodeURIComponent(purchase.details_token)}`;

/* Hand-issued payment links carry this contract in their metadata: the slot,
   and a purpose naming the kind of sale and the month the run starts.
   Their sessions have no purchase row to promote — this creates one. */
const LINK_PURPOSE_RE = /^sponsor_(renewal|public)_(\d{4})_(\d{2})$/;

export async function reconcileLinkSession(session) {
  const meta = session?.metadata || {};
  const m = LINK_PURPOSE_RE.exec(meta.purpose || '');
  if (!m) return false;

  const [, kind, year, month] = m;
  if (session.payment_status !== 'paid') {
    console.warn(`link session ${session.id} (${meta.purpose}) not paid, ignoring`);
    return true;
  }
  // Same delivery twice: the first one already wrote the row.
  if (await purchaseBySession(session.id)) return true;

  const slotId = String(meta.slot_id || '').toUpperCase();
  if (!SLOT_IDS.includes(slotId) || Number(month) < 1 || Number(month) > 12) {
    await alertAdmin(
      `link payment could not be reconciled (${esc(meta.purpose)} / slot "${meta.slot_id}")`,
      shell(
        `<p>Session <code>${esc(session.id)}</code> (${esc(meta.purpose)}, ${esc(meta.sponsor || 'no name')},`
        + ` ${usd(session.amount_total)}) carries a slot or month that doesn't exist. Nothing was`
        + ` recorded; sort it by hand.</p>`
      )
    );
    return true;
  }

  const now = Date.now();
  const months = Math.max(1, Math.min(12, Number(meta.months) || 1));
  const startsAt = Date.UTC(Number(year), Number(month) - 1, 1);
  const endsAt = startsAt + RUN_MS * months;
  const email = session.customer_details?.email ?? null;

  /* One term, one payment. A second payment against the same slot and an
     overlapping term is not recorded — money moved, so a human decides which
     payment stands and refunds the other. An outgoing run spilling a few days
     into the new term is normal and doesn't count. */
  const actives = await activePurchases();
  const conflict = actives.find((o) => {
    if (o.slot_id !== slotId || o.status === 'hold') return false;
    const oStart = o.starts_at ?? 0;
    const oEnd = o.ends_at ?? Number.MAX_SAFE_INTEGER;
    if (!(oStart < endsAt && oEnd > startsAt)) return false;
    return !(oStart <= startsAt && oEnd <= startsAt + SPILL_MS);
  });
  if (conflict) {
    await alertAdmin(
      `link payment NOT recorded · ${slotId} already booked for that term`,
      shell(
        `<p>Session <code>${esc(session.id)}</code> (${esc(meta.purpose)},`
        + ` ${esc(meta.sponsor || email || 'no name')}, ${usd(session.amount_total)},`
        + ` payment <code>${esc(session.payment_intent || 'unknown')}</code>) overlaps existing`
        + ` purchase <code>${esc(conflict.id)}</code> (${esc(conflict.status)}).</p>`
        + `<p><b>The money HAS been taken.</b> Refund one of the two from the Stripe dashboard,`
        + ` then sort the board on <a href="${esc(siteUrl('/admin/sponsors'))}">the admin page</a>.</p>`
      )
    );
    return true;
  }

  // A renewal keeps the card that's already running in the slot; without one
  // to carry over, the buyer fills in details like any other purchase.
  const incumbent = kind === 'renewal'
    ? actives.find((o) => o.slot_id === slotId && isLive(o, now))
    : null;

  const purchase = {
    id: crypto.randomUUID(),
    slot_id: slotId,
    status: incumbent ? 'live' : 'paid',
    amount_cents: session.amount_total ?? null,
    months,
    details_token: newToken(),
    created_at: now,
    hold_expires_at: null,
    stripe_session_id: session.id,
  };
  try {
    await insertPurchase(purchase);
  } catch (err) {
    // Two deliveries racing: whoever lost the unique session id did nothing.
    console.warn(`link session ${session.id} insert failed: ${err?.message || err}`);
    return true;
  }
  try {
    await updatePurchase(purchase.id, {
      stripe_payment_intent: session.payment_intent ?? null,
      email: email ?? incumbent?.email ?? null,
      paid_at: now,
      starts_at: startsAt,
      ends_at: endsAt,
      ...(incumbent
        ? {
            name: incumbent.name,
            tagline: incumbent.tagline,
            url: incumbent.url,
            logo_url: incumbent.logo_url,
            tint: incumbent.tint,
            submitted_at: now,
            approved_at: now,
          }
        : {}),
    });
    // The next run is sold: the slot's next-run state resets so the month
    // after doesn't silently inherit "open".
    await setSlotNextState(slotId, 'pending');
  } catch (err) {
    // The row exists but is missing its term — money moved, so this must
    // never fail silently.
    console.error(`link session ${session.id} completion failed: ${err?.message || err}`);
    await alertAdmin(
      `link payment recorded INCOMPLETELY · ${slotId}`,
      shell(
        `<p>Purchase <code>${esc(purchase.id)}</code> for session <code>${esc(session.id)}</code>`
        + ` (${esc(meta.sponsor || email || 'no name')}, ${usd(session.amount_total)}) was inserted`
        + ` but its term and details failed to write: ${esc(err?.message || err)}.</p>`
        + `<p>It will not show on the board until fixed. Check the`
        + ` <a href="${esc(siteUrl('/admin/sponsors'))}">admin page</a>.</p>`
      )
    );
    return true;
  }
  clearCache();

  const toEmail = email ?? incumbent?.email;
  if (incumbent) {
    await sendMail({
      to: toEmail,
      subject: `locked in · ${purchase.slot_id} is yours ${shortDate(startsAt)} to ${shortDate(endsAt)}`,
      html: brandShell(
        `<p>Payment received. <b>${esc(incumbent.name)}</b> keeps slot ${esc(purchase.slot_id)}`
        + ` from ${esc(shortDate(startsAt))} to ${esc(shortDate(endsAt))}: same card, same spot,`
        + ` nothing to do.</p>`
        + `<p>Your numbers for the current run:`
        + ` <a href="${esc(`${siteUrl('/sponsor/stats')}?t=${encodeURIComponent(incumbent.details_token)}`)}">stats page</a>.`
        + ` The new run gets its own page, filling in from ${esc(shortDate(startsAt))}:`
        + ` <a href="${esc(`${siteUrl('/sponsor/stats')}?t=${encodeURIComponent(purchase.details_token)}`)}">keep this link</a>.</p>`
        + `<p style="color:#6e6e67; font-size:12px;">Want anything on the card changed for the`
        + ` new run? Reply to this email.</p>`
        + recPs('email_sponsor')
      ),
    });
  } else {
    await sendMail({
      to: toEmail,
      subject: `you're in · slot ${purchase.slot_id} just needs your card details`,
      html: brandShell(
        `<p>Payment received for slot ${esc(purchase.slot_id)}, running`
        + ` ${esc(shortDate(startsAt))} to ${esc(shortDate(endsAt))}. One step left: tell us`
        + ` what the card should say.</p>`
        + `<p>${button(detailsLink(purchase), 'finish your card')}</p>`
        + `<p style="color:#6e6e67; font-size:12px;">Name, one line, and your link. We review`
        + ` every placement by hand after that. Keep this email; it's the only copy of your link.</p>`
        + recPs('email_sponsor')
      ),
    });
  }

  await alertAdmin(
    `${kind} paid: ${slotId} from ${shortDate(startsAt)} · ${meta.sponsor || toEmail || 'unknown'} (${usd(session.amount_total)})`,
    shell(
      `<p>Slot ${esc(slotId)} ${esc(kind)} reconciled: ${esc(meta.sponsor || 'no name in metadata')},`
      + ` ${usd(session.amount_total)}, runs ${esc(shortDate(startsAt))}–${esc(shortDate(endsAt))}`
      + `${months > 1 ? ` (${months} runs)` : ''}.</p>`
      + (incumbent
        ? `<p>Card carried over from the current run; nothing to approve.</p>`
        : `<p>The buyer was emailed for card details. If that email bounces, their details link is:`
          + ` <a href="${esc(detailsLink(purchase))}">${esc(detailsLink(purchase))}</a></p>`)
      + `<p><a href="${esc(siteUrl('/admin/sponsors'))}">admin</a></p>`
    )
  );
  return true;
}

/* hold → paid. Called by the webhook and, when the webhook hasn't landed yet,
   by the details page off its own session lookup. The conditional update is
   what makes that safe: whichever arrives second changes nothing.

   `notify` sends the "finish your card" email. The webhook sets it; the details
   page doesn't, because that visitor is already looking at the form. */
export async function promoteFromSession(session, { notify = false } = {}) {
  if (!session) return null;
  const id = session.metadata?.purchase_id || session.client_reference_id;
  // The session id is written just after the session is created, so a very fast
  // webhook can beat it into the row — the metadata is authoritative.
  const purchase = id ? await purchaseById(id) : await purchaseBySession(session.id);
  if (!purchase) return null;
  if (session.payment_status !== 'paid') {
    console.warn(
      `sponsor session ${session.id} arrived with payment_status=${session.payment_status}, not promoting`
    );
    return purchase;
  }

  const now = Date.now();
  const changed = await updatePurchase(
    purchase.id,
    {
      status: 'paid',
      paid_at: now,
      stripe_session_id: session.id,
      stripe_payment_intent: session.payment_intent ?? null,
      email: session.customer_details?.email ?? null,
    },
    ['hold', 'expired_hold']
  );
  if (!changed) return purchaseById(purchase.id);
  clearCache();

  const email = session.customer_details?.email ?? purchase.email;

  /* Several people can be in checkout for one slot at once, so payments race.
     The winner is whoever paid first, under a strict order on (paid_at, id).
     That order is what keeps this safe: if A beats B then B cannot also beat A,
     so two payers can never both refund themselves. The only way they could
     both survive is if neither ever saw the other, so the check runs twice —
     by the second pass both rows are certainly committed and visible.

     Whoever queued first is irrelevant: a lapsed hold can be paid late, and a
     success tab can be reopened long after the slot moved on. An unpaid hold is
     never a rival — it holds nothing until it pays, and then it lands here.

     A purchase for a future run only rivals purchases whose TERM overlaps its
     own — the placement currently finishing out the slot is not a rival, and
     may spill a few days into the new term. */
  const mine = await purchaseById(purchase.id);
  const rivalTo = (o, at) => {
    if (mine?.starts_at && mine?.ends_at) {
      if (o.status === 'hold') return false;
      const oS = o.starts_at ?? 0;
      const oE = o.ends_at ?? Number.MAX_SAFE_INTEGER;
      if (!(oS < mine.ends_at && oE > mine.starts_at)) return false;
      return !(oS <= mine.starts_at && oE <= mine.starts_at + SPILL_MS);
    }
    return blocksSlot(o, at);
  };
  const beatenBy = async () => {
    const at = Date.now();
    return (await activePurchases()).filter((o) => {
      if (o.slot_id !== purchase.slot_id || o.id === purchase.id) return false;
      if (!rivalTo(o, at)) return false;
      const theirs = o.paid_at ?? 0;
      return theirs < now || (theirs === now && o.id < purchase.id);
    });
  };
  let rivals = await beatenBy();
  if (rivals.length === 0) rivals = await beatenBy();

  if (rivals.length === 0) {
    // A future run just sold: reset the slot's next-run state so the month
    // after doesn't silently inherit "open".
    if (mine?.starts_at && mine.starts_at > now) {
      await setSlotNextState(purchase.slot_id, 'pending');
      clearCache();
    }
    if (notify) {
      // Fire-and-forget: the details link only otherwise exists in the tab they
      // were redirected to, and tabs get closed.
      await sendMail({
        to: email,
        subject: `you're in · slot ${purchase.slot_id} just needs your card details`,
        html: brandShell(
          `<p>Payment received for slot ${esc(purchase.slot_id)}. One step left: tell us what`
          + ` the card should say.</p>`
          + `<p>${button(detailsLink(purchase), 'finish your card')}</p>`
          + `<p style="color:#6e6e67; font-size:12px;">Name, one line, and your link. We review`
          + ` every placement by hand after that, usually within a few hours. Keep this email;`
          + ` it's the only copy of your link.</p>`
          + recPs('email_sponsor')
        ),
      });
    }
    return purchaseById(purchase.id);
  }

  const rivalList = rivals.map((r) => `${r.id} (${r.status})`).join(', ');
  let refundError = null;
  try {
    // Keyed on the purchase: a retry after a lost response can't refund twice.
    await createRefund(session.payment_intent, `refund-${purchase.id}`);
    await updatePurchase(purchase.id, { status: 'refunded_conflict' }, ['paid']);
    await sendMail({
      to: email,
      subject: 'your sponsor slot was taken first · refunded',
      html: brandShell(
        `<p>Slot ${esc(purchase.slot_id)} was bought by someone else before this payment`
        + ` landed, so your payment has been refunded in full. It's back on your card in`
        + ` 5–10 days.</p>`
        + `<p>Sorry about that. Other slots may still be open:`
        + ` <a href="${esc(siteUrl('/sponsor'))}">${esc(siteUrl('/sponsor'))}</a></p>`
      ),
    });
  } catch (err) {
    refundError = err;
    await updatePurchase(purchase.id, { status: 'reject_failed' }, ['paid']);
  }

  // Faizan hears about every double-booking, not just the ones that fail to refund:
  // two people paid for one slot and he needs to know it happened.
  await alertAdmin(
    `sponsor slot ${purchase.slot_id} double-booked${refundError ? ' · REFUND FAILED' : ' (auto-refunded)'}`,
    shell(
      `<p>Purchase <code>${esc(purchase.id)}</code> (${esc(email || 'no email')}) paid for slot`
      + ` ${esc(purchase.slot_id)}, which was already held by: ${esc(rivalList)}.</p>`
      + (refundError
        ? `<p><b>The automatic refund failed:</b> ${esc(refundError?.message || refundError)}</p>`
          + `<p>The slot stays blocked until this is settled. Retry from`
          + ` <a href="${esc(siteUrl('/admin/sponsors'))}">the admin page</a>.</p>`
        : `<p>It was refunded in full automatically and the buyer has been told. Nothing to do.</p>`)
    )
  );
  clearCache();
  return purchaseById(purchase.id);
}

export async function POST({ request }) {
  // Raw bytes, never readBody: parsing first would change what we hash.
  const raw = await request.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!verifyStripeSignature(raw, request.headers.get('stripe-signature'), secret)) {
    // Parsed only to name the event in the log — the payload stays untrusted.
    let id = 'none';
    try {
      id = JSON.parse(raw)?.id || 'none';
    } catch {}
    console.error(
      `sponsor webhook rejected: bad signature (event ${id}, secret ${secret ? 'set' : 'MISSING'})`
    );
    return json({ error: 'bad signature' }, 400);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const object = event?.data?.object;
  try {
    if (event.type === 'checkout.session.completed') {
      // Hand-issued link sessions have no purchase to promote; they get a row
      // of their own instead. Everything else takes the normal path.
      if (!(await reconcileLinkSession(object))) {
        await promoteFromSession(object, { notify: true });
      }
    } else if (event.type === 'checkout.session.expired') {
      const purchase = object?.metadata?.purchase_id
        ? await purchaseById(object.metadata.purchase_id)
        : await purchaseBySession(object?.id);
      if (purchase) {
        await updatePurchase(purchase.id, { status: 'expired_hold' }, ['hold']);
        clearCache();
      }
    }
  } catch (err) {
    // A verified event that we mishandled is our bug, not Stripe's: log it and
    // acknowledge, or Stripe retries the same failure for days.
    console.error(`sponsor webhook ${event.type} failed: ${err?.message || err}`);
  }

  return json({ ok: true });
}
