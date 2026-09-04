/* Transactional mail to a sponsor's contact address — with a belt (E1).
   The address is UNVERIFIED (typed at bid time, frozen at first clear), so an
   attacker could park a victim's address on their own sponsor and let our
   held/outbid notices harass it. Two cheap controls kill that class:

   1. Suppression: if the address has unsubscribed on Resend, nothing sends.
      Fail-open on API trouble (no creds / timeout / not a contact): the HARD
      guarantee is the caps below, and a Resend blip must not silently kill
      legitimate held-notifications.
   2. Hard per-address caps, db-backed: at most 1 transactional mail per hour
      and 3 per day per address — regardless of how many cleared payments an
      attacker burns, the address sees at most 3 mails a day, ever.

   All Build Games sponsor-facing mail goes through here. alertAdmin and the
   opt-in LIST path (waitlist + Resend, its own unsubscribe) are separate. */
import { rateLimit } from './db.js';
import { brandShell, esc, recPs, sendMail, unmailable } from './mail.js';
import { usd } from './buildgames.js';

async function suppressed(email) {
  const key = process.env.RESEND_API_KEY;
  const audience = process.env.RESEND_AUDIENCE_ID;
  if (!key || !audience) return false;
  try {
    const res = await fetch(
      `https://api.resend.com/audiences/${audience}/contacts/${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return false; // 404 = never a contact = nothing to honour
    return (await res.json())?.unsubscribed === true;
  } catch {
    return false;
  }
}

/* The payer's receipt — ONE implementation, called by whichever side's
   clearPayment actually returned true (webhook OR the details page's
   race-settler), so it sends exactly once per capture and never depends on
   which of the two arrived first. Fire-and-forget by construction: nothing
   here can block or fail the money path. Goes to the Stripe-checkout email
   (payment-verified), so the E1 caps deliberately do not apply — receipts
   are 1:1 with real captures. */
export function bgReceiptHtml({ capturedCents, ref }) {
  return brandShell(
    `<p>Payment received: <b>${usd(capturedCents)}</b> for a sponsored placement on the`
    + ` vibecodeit.com board.</p>`
    + `<p>Your placement is live and ranks by cumulative sponsorship. You keep your spot`
    + ` until another sponsor's total passes yours.</p>`
    + `<p><a href="https://vibecodeit.com/thebuildgames">see the board</a></p>`
    + `<p style="color:#6e6e67; font-size:12px;">Reference: ${esc(String(ref))}. Stripe also`
    + ` emails an invoice for your records. Questions? Reply to this email.</p>`
    + recPs('email_sponsor')
  );
}

export function sendBgReceipt({ to, capturedCents, ref }) {
  if (!to) return;
  sendMail({
    to,
    subject: `receipt · ${usd(capturedCents)} sponsored placement — vibecodeit.com`,
    html: bgReceiptHtml({ capturedCents, ref }),
  }).catch((err) => console.error(`bg receipt mail failed: ${err.message}`));
}

/* The entrant's edit link — TRANSACTIONAL, so it goes through plain
   sendMail like the payer's receipt, never the E1 marketing caps or the
   suppression list (an entrant who unsubscribed from the newsletter still
   owns their entry). Abuse is bounded without caps: the duplicate-email 409
   means at most ONE of these can ever be triggered per address, behind the
   5/hr/IP entry rate limit. Fire-and-forget: a mail outage must not fail
   the entry. */
export function entryEditLinkHtml(editUrl) {
  return brandShell(
    `<p>You're in. Your Build Games entry is submitted.</p>`
    + `<p>Edit your entry any time before the window closes:</p>`
    + `<p><a href="${esc(editUrl)}">${esc(editUrl)}</a></p>`
    + `<p style="color:#6e6e67; font-size:12px;">Keep this link private, anyone with it can edit your entry.`
    + ` Winners are announced after judging. Questions? Reply to this email.</p>`
    + recPs('email_entry')
  );
}

export function sendEntryEditLink({ to, editUrl }) {
  const addr = String(to || '').trim().toLowerCase();
  if (!addr || unmailable(addr)) return;
  sendMail({
    to: addr,
    subject: 'your Build Games entry — the edit link',
    html: entryEditLinkHtml(editUrl),
  }).catch((err) => console.error(`bg entry mail failed: ${err.message}`));
}

/* Returns true if the mail was actually handed to sendMail. */
export async function sendSponsorMail({ to, subject, html }) {
  const addr = String(to || '').trim().toLowerCase();
  if (!addr || unmailable(addr)) return false;
  // Caps first (cheap, local, the hard guarantee), suppression second.
  if (!(await rateLimit(`bgmail:h:${addr}`, 1, 60 * 60 * 1000))) return false;
  if (!(await rateLimit(`bgmail:d:${addr}`, 3, 24 * 60 * 60 * 1000))) return false;
  if (await suppressed(addr)) return false;
  await sendMail({ to: addr, subject, html });
  return true;
}
