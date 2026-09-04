import {
  activePurchases, purchaseById, rateLimit, setSlotNextState, setSlotPrice,
  updatePurchase, waitlistEmails,
} from '../../../lib/db.js';
import { alertAdmin, brandShell, esc, sendBatch, sendMail, shell, unsubscribedEmails } from '../../../lib/mail.js';
import { json, readBody } from '../../../lib/request.js';
import {
  cleanText, cleanTint, cleanUrl, clearCache, getBoard, isAdmin, isLive, LIMITS, nextRunStart,
  RUN_DAYS, RUN_MS, shortDate, siteUrl, SLOT_IDS, SPILL_MS, usd, verifyAction,
} from '../../../lib/sponsors.js';
import { alreadyRefunded, createPaymentLink, createRefund } from '../../../lib/stripe.js';

const NEXT_STATES = ['pending', 'open', 'reserved'];

const REFUNDABLE = ['submitted', 'paid', 'reject_failed'];

export async function POST({ request }) {
  const wantsJson = (request.headers.get('content-type') || '').includes('application/json');

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const action = String(body.action ?? '');
  const id = String(body.id ?? '');
  // Two ways in: the admin token, or a signature that authorises exactly this
  // action on exactly this purchase (that's what the emailed links carry).
  const allowed = isAdmin(body.token) || (id && verifyAction(id, action, body.sig));
  if (!allowed) return json({ error: 'not found' }, 404);

  // Same-origin paths only: "//evil.com" and "/\evil.com" are both absolute to
  // a browser, so a leading slash on its own proves nothing.
  const backTo = (message) => {
    const back = String(body.return_to || '');
    const target = /^\/(?![/\\])/.test(back) ? back : '/sponsor';
    const sep = target.includes('?') ? '&' : '?';
    return new Response(null, {
      status: 303,
      headers: { Location: `${target}${sep}msg=${encodeURIComponent(message)}` },
    });
  };

  const done = (message) => {
    clearCache();
    return wantsJson ? json({ ok: true, message }) : backTo(message);
  };

  /* Faizan approves from his phone, where a bare JSON 409 is invisible. Form posts
     go back to the page with the reason; JSON callers keep the status code. */
  const fail = (error, status) => (wantsJson ? json({ error }, status) : backTo(error));

  if (action === 'price') {
    const slot = String(body.slot ?? '').trim().toUpperCase();
    const dollars = Number(body.price);
    if (!SLOT_IDS.includes(slot)) return fail('unknown slot', 400);
    if (!Number.isFinite(dollars) || dollars < 1 || dollars > 100000) {
      return fail('bad price', 400);
    }
    await setSlotPrice(slot, Math.round(dollars * 100));
    return done(`${slot} priced at ${usd(Math.round(dollars * 100))}`);
  }

  /* One tap, human-triggered, never automatic: tell everyone who asked to be
     pinged that slots are buyable. Anyone who unsubscribed from the audience is
     excluded — if that can't be checked, nobody gets mailed. Guarded so a
     double-tap can't double-mail. */
  if (action === 'queue_blast') {
    const board = await getBoard();
    const nowOpen = board.slots.filter((s) => s.state === 'open');
    const nextOpen = board.slots.filter(
      (s) => s.state !== 'open' && s.nextState === 'open' && !s.nextTaken
    );
    if (nowOpen.length === 0 && nextOpen.length === 0) {
      return fail('nothing open to announce', 409);
    }
    let recipients;
    try {
      const gone = await unsubscribedEmails();
      recipients = (await waitlistEmails('sponsor')).filter((e) => !gone.has(e.toLowerCase()));
    } catch (err) {
      console.error(`queue blast blocked: ${err?.message || err}`);
      return fail('could not check unsubscribes; nobody mailed', 502);
    }
    if (recipients.length === 0) return fail('the queue is empty', 409);
    if (!(await rateLimit('sponsor-queue-blast', 1, 12 * 60 * 60 * 1000))) {
      return fail('queue was already emailed in the last 12h', 429);
    }

    const startLabel = shortDate(nextRunStart());
    const lines = [
      ...nowOpen.map((s) => `<li>slot ${esc(s.id)} · ${usd(s.priceCents)}, live as soon as your card is approved</li>`),
      ...nextOpen.map((s) => `<li>slot ${esc(s.id)} · ${usd(s.priceCents)}, yours from ${esc(startLabel)}</li>`),
    ].join('');
    const subject = nowOpen.length > 0
      ? 'a sponsor slot just opened on vibecodeit'
      : `${startLabel.split(' ')[0].toLowerCase()} sponsor slots just opened on vibecodeit`;
    const html = brandShell(
      `<p>You asked to be pinged when a vibecodeit sponsor slot opens. Open right now:</p>`
      + `<ul>${lines}</ul>`
      + `<p>Fixed slots, one-off 30-day terms, first paid, first placed.</p>`
      + `<p><a href="${esc(siteUrl('/sponsor'))}">take one → ${esc(siteUrl('/sponsor'))}</a></p>`
      + `<p style="color:#6e6e67; font-size:12px;">You're getting this because you left your`
      + ` email on the sponsor page. Reply "stop" and you won't again.</p>`
    );

    const sent = await sendBatch(recipients.map((to) => ({ to, subject, html })));
    return done(`queue emailed: ${sent} of ${recipients.length}`);
  }

  if (action === 'next_state') {
    const slot = String(body.slot ?? '').trim().toUpperCase();
    const state = String(body.state ?? '').trim();
    if (!SLOT_IDS.includes(slot)) return fail('unknown slot', 400);
    if (!NEXT_STATES.includes(state)) return fail('bad state', 400);
    await setSlotNextState(slot, state);
    return done(`${slot} next run: ${state}`);
  }

  /* Mints a shareable checkout link for a slot's next run. The metadata is the
     whole contract: the webhook turns the eventual payment into a purchase row
     with the right term, so the link can be sent anywhere. */
  if (action === 'payment_link') {
    const slot = String(body.slot ?? '').trim().toUpperCase();
    const kind = String(body.kind ?? '') === 'public' ? 'public' : 'renewal';
    const dollars = Number(body.price);
    const months = String(body.months ?? '1').trim() === '3' ? 3 : 1;
    const term = /^(\d{4})-(\d{2})$/.exec(String(body.term ?? '').trim());
    const sponsor = cleanText(body.sponsor, 60) ?? '';
    if (!SLOT_IDS.includes(slot)) return fail('unknown slot', 400);
    if (!Number.isFinite(dollars) || dollars < 1 || dollars > 100000) return fail('bad price', 400);
    if (!term || Number(term[2]) < 1 || Number(term[2]) > 12) return fail('bad term (YYYY-MM)', 400);
    try {
      const link = await createPaymentLink({
        name: `vibecodeit.com · sponsor slot ${slot} (${RUN_DAYS * months} days)`,
        priceCents: Math.round(dollars * 100),
        metadata: {
          purpose: `sponsor_${kind}_${term[1]}_${term[2]}`,
          slot_id: slot,
          sponsor,
          months,
        },
        // A double-tap mints the same link instead of a duplicate.
        idempotencyKey: `plink-${slot}-${kind}-${term[1]}${term[2]}-${Math.round(dollars * 100)}-${months}`,
      });
      return done(`${slot} ${kind} link (${usd(Math.round(dollars * 100))} total, ${RUN_DAYS * months} days): ${link.url}`);
    } catch (err) {
      console.error(`payment link failed: ${err?.message || err}`);
      return fail('stripe refused the link; check the log', 502);
    }
  }

  const purchase = id ? await purchaseById(id) : null;
  if (!purchase) return json({ error: 'not found' }, 404);

  if (action === 'approve') {
    const now = Date.now();
    // A purchase that already carries a future run keeps its dates — approval
    // just clears the card to show when that run arrives. Everything else
    // starts its clock at approval, not payment: nobody pays for the days we
    // spent reviewing them.
    const scheduled = purchase.starts_at && purchase.starts_at > now;
    const startsAt = scheduled ? purchase.starts_at : now;
    const endsAt = scheduled
      ? purchase.ends_at
      : now + RUN_MS * (Number(purchase.months) || 1);

    /* Last line of defence against double-booking. For a run starting now,
       refuse if the slot is already showing someone. For a future run, refuse
       if another future run overlaps it, or if the current placement would
       still be running more than the allowed spill into it. */
    const clash = (await activePurchases()).find((o) => {
      if (o.slot_id !== purchase.slot_id || o.id === purchase.id) return false;
      if (!scheduled) return isLive(o, now);
      if (isLive(o, now) && o.ends_at > startsAt + SPILL_MS) return true;
      return o.status !== 'hold' && o.starts_at && o.ends_at
        && o.starts_at > now && o.starts_at < endsAt && o.ends_at > startsAt;
    });
    if (clash) {
      return fail(`${purchase.slot_id} is already booked; refund one of these first`, 409);
    }

    const changed = await updatePurchase(
      purchase.id,
      { status: 'live', approved_at: now, starts_at: startsAt, ends_at: endsAt },
      ['submitted']
    );
    if (!changed) return fail('not awaiting approval', 409);
    await sendMail({
      to: purchase.email,
      subject: scheduled
        ? `approved · you're live from ${shortDate(startsAt)}`
        : `you're live on vibecodeit until ${shortDate(endsAt)}`,
      html: brandShell(
        `<p><b>${esc(purchase.name)}</b> is approved for slot ${esc(purchase.slot_id)}`
        + (scheduled
          ? ` and goes up ${esc(shortDate(startsAt))}, running until ${esc(shortDate(endsAt))}.</p>`
          : ` right now, and runs until ${esc(shortDate(endsAt))} (${RUN_DAYS * (Number(purchase.months) || 1)} days).</p>`)
        + `<p>Your link carries campaign tags, so the traffic shows up in your analytics as`
        + ` vibecodeit / referral.</p>`
      ),
    });
    return done(`${purchase.slot_id} live ${scheduled ? `${shortDate(startsAt)} to` : 'until'} ${shortDate(endsAt)}`);
  }

  if (action === 'reject' || action === 'retry_refund') {
    if (!REFUNDABLE.includes(purchase.status)) return fail('nothing to refund', 409);
    const isRetry = action === 'retry_refund';
    try {
      if (!purchase.stripe_payment_intent) throw new Error('no payment intent on this purchase');
      /* Stripe stores and replays the response for an idempotency key, errors
         included — so a first attempt that failed on something temporary (an
         insufficient balance on a young account) would replay that same failure
         forever if the retry reused the key. A manual retry therefore looks up
         the payment first and, only if nothing is on its way back, tries again
         under a fresh key. The automatic path keeps the static key: it fires
         without a human and must never refund twice. */
      const settled = isRetry && (await alreadyRefunded(purchase.stripe_payment_intent));
      if (!settled) {
        await createRefund(
          purchase.stripe_payment_intent,
          isRetry ? `refund-${purchase.id}-retry-${Date.now()}` : `refund-${purchase.id}`
        );
      }
    } catch (err) {
      await updatePurchase(purchase.id, { status: 'reject_failed' }, REFUNDABLE);
      clearCache();
      await alertAdmin(
        `sponsor refund FAILED (${purchase.slot_id})`,
        shell(
          `<p>Refunding <code>${esc(purchase.id)}</code> failed: ${esc(err?.message || err)}</p>`
          + `<p>Retry from <a href="${esc(siteUrl('/admin/sponsors'))}">the admin page</a>.</p>`
        )
      );
      return fail('refund failed; retry from the admin page', 502);
    }
    await updatePurchase(purchase.id, { status: 'rejected' }, REFUNDABLE);
    await sendMail({
      to: purchase.email,
      subject: 'your vibecodeit sponsor slot · refunded',
      html: brandShell(
        `<p>We didn't run this placement, and your payment has been refunded in full.`
        + ` It lands back on your card in 5–10 days.</p>`
        + `<p>Reply to this email if you want to know why, or want another go at it.</p>`
      ),
    });
    return done(`${purchase.slot_id} rejected and refunded`);
  }

  if (action === 'expire') {
    const changed = await updatePurchase(
      purchase.id,
      { status: 'expired', ends_at: Date.now() },
      ['live']
    );
    if (!changed) return fail('not live', 409);
    return done(`${purchase.slot_id} taken down`);
  }

  if (action === 'clear_hold') {
    const changed = await updatePurchase(purchase.id, { status: 'expired_hold' }, ['hold']);
    if (!changed) return fail('not on hold', 409);
    return done(`${purchase.slot_id} hold cleared`);
  }

  if (action === 'edit') {
    const fields = {};
    if (body.name) fields.name = cleanText(body.name, LIMITS.name);
    if (body.tagline) fields.tagline = cleanText(body.tagline, LIMITS.tagline);
    if (body.url) fields.url = cleanUrl(body.url);
    if (body.logo_url) fields.logo_url = cleanUrl(body.logo_url);
    if (body.tint) fields.tint = cleanTint(body.tint);
    if (Object.values(fields).some((v) => v === null)) return fail('invalid value', 400);
    if (Object.keys(fields).length === 0) return fail('nothing to change', 400);
    await updatePurchase(purchase.id, fields);
    return done(`${purchase.slot_id} updated`);
  }

  return fail('unknown action', 400);
}
