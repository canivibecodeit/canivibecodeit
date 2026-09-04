/* Stripe webhook for The Build Games — the UNATTENDED money path:
   checkout.session.completed → clearPayment with the CAPTURED amount → the
   placement lists itself (identity frozen from the payment's screen). No
   human in the loop; admin is moderation only.

   H4 discipline, all four:
   - H4.1 amount binding: the payment clears at session.amount_total — what
     Stripe actually captured — never the amount recorded at bid time. A
     mismatch clears at the captured figure AND alerts.
   - H4.2 unique ref: the capture's payment_intent becomes processor_ref under
     a unique index; a replayed or cross-wired delivery throws and credits
     nothing (clearPayment alerts).
   - H4.3 atomic pending→cleared: one UPDATE, one winner; Stripe's retries and
     duplicate deliveries are no-ops.
   - H4.4 lives in submitBid (ON CONFLICT sponsor insert).

   Registered separately from the sponsor-slot webhook; its secret is
   STRIPE_BUILDGAMES_WEBHOOK_SECRET (falls back to STRIPE_WEBHOOK_SECRET when
   one endpoint serves both). Events: checkout.session.completed,
   checkout.session.expired, charge.refunded, charge.dispute.created. */
import { bgPaymentByProcessorRef, expireBgPaymentAtomic } from '../../../lib/db.js';
import { alertAdmin, esc } from '../../../lib/mail.js';
import { sendBgReceipt } from '../../../lib/buildgames-mail.js';
import { json } from '../../../lib/request.js';
import { verifyStripeSignature } from '../../../lib/stripe.js';
import { PAYMENT_ID_RE, usd } from '../../../lib/buildgames.js';
import { clearPayment, reversePayment } from '../../../lib/buildgames-payments.js';

export async function POST({ request }) {
  // Raw bytes, never readBody: parsing first would change what we hash.
  const raw = await request.text();
  const secret = process.env.STRIPE_BUILDGAMES_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  if (!verifyStripeSignature(raw, request.headers.get('stripe-signature'), secret)) {
    let id = 'none';
    try {
      id = JSON.parse(raw)?.id || 'none';
    } catch {}
    console.error(`buildgames webhook rejected: bad signature (event ${id}, secret ${secret ? 'set' : 'MISSING'})`);
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
    if (event.type === 'checkout.session.completed' && object?.metadata?.kind === 'buildgames') {
      const paymentId = String(object.metadata.payment_id || '');
      if (!PAYMENT_ID_RE.test(paymentId)) {
        await alertAdmin(
          '[cvci] build games webhook: paid session with no payment id',
          `<p>Session <code>${esc(object.id)}</code> (${usd(object.amount_total ?? 0)}) completed but carries no valid payment_id. Money moved; reconcile by hand.</p>`
        );
        return json({ ok: true });
      }
      if (object.payment_status !== 'paid') {
        console.warn(`bg session ${object.id} completed with payment_status=${object.payment_status}, not clearing`);
        return json({ ok: true });
      }
      const captured = Math.round(Number(object.amount_total));
      if (!Number.isInteger(captured) || captured <= 0 || (object.currency && object.currency !== 'usd')) {
        await alertAdmin(
          '[cvci] build games webhook: unusable capture',
          `<p>Session <code>${esc(object.id)}</code> for <code>${esc(paymentId)}</code>: amount_total=${esc(String(object.amount_total))} ${esc(String(object.currency))}. Not cleared; reconcile by hand.</p>`
        );
        return json({ ok: true });
      }
      const ref = object.payment_intent || object.id;
      const cleared = await clearPayment(paymentId, { capturedCents: captured, processorRef: ref });
      if (cleared) {
        console.log(`bg payment ${paymentId} cleared · ${usd(captured)} · ${ref}`);
        // Receipt: ONE shared implementation, sent by whichever side's clear
        // actually returned true — here, or the details page's race-settler
        // when the payer beat this delivery. Exactly-once by construction.
        sendBgReceipt({ to: object.customer_details?.email, capturedCents: captured, ref });
      }
    } else if (event.type === 'checkout.session.expired' && object?.metadata?.kind === 'buildgames') {
      const paymentId = String(object.metadata.payment_id || '');
      if (PAYMENT_ID_RE.test(paymentId)) await expireBgPaymentAtomic(paymentId);
    } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      // Money going back (or frozen): reverse the payment the capture cleared.
      // It drops out of the pot and the sponsor's rank sum automatically.
      // Non-buildgames charges simply don't match a processor_ref — no-op.
      const pi = object?.payment_intent;
      const p = pi ? await bgPaymentByProcessorRef(pi) : null;
      if (p) {
        const reversed = await reversePayment(p.id);
        await alertAdmin(
          `[cvci] build games ${event.type === 'charge.refunded' ? 'refund' : 'DISPUTE'} · ${usd(p.amount_cents)}`,
          `<p>Payment <code>${esc(p.id)}</code> (${usd(p.amount_cents)}, sponsor <code>${esc(p.sponsor_id)}</code>) was ${event.type === 'charge.refunded' ? 'refunded' : 'disputed'}${reversed ? ' and reversed off the board/pot' : ' — reversal was a no-op (already reversed?)'}.</p>
           <p><a href="https://vibecodeit.com/admin/thebuildgames">the queue</a></p>`
        ).catch((err) => console.error(`bg reverse alert failed: ${err.message}`));
      }
    }
  } catch (err) {
    // A verified event we mishandled is our bug — log + acknowledge, or
    // Stripe retries the same failure for days. But we still acknowledge with
    // a 200, so this is the one path where money can move while the board does
    // not: a captured payment whose sponsor never gets listed, with nobody
    // told. Always raise it — a silent loss becomes a message we can act on.
    console.error(`buildgames webhook ${event.type} failed: ${err?.message || err}`);
    await alertAdmin(
      'Build Games: webhook event failed',
      `<p>A signature-verified Stripe event was accepted but could not be processed.
         Money may have been captured without a placement appearing.</p>
       <p><b>event:</b> ${esc(event.type)}<br>
          <b>event id:</b> ${esc(event.id || 'unknown')}<br>
          <b>error:</b> ${esc(err?.message || String(err))}</p>
       <p>Stripe will NOT retry (we return 200). Reconcile by hand:
          <a href="https://vibecodeit.com/admin/thebuildgames">the queue</a></p>`
    ).catch((mailErr) => console.error(`bg webhook alert failed: ${mailErr.message}`));
  }

  return json({ ok: true });
}
