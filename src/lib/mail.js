/* Transactional mail over Resend's REST API.

   The sender constants are duplicated from the digest script on purpose: that
   script is a standalone cron job with its own env loading and must keep
   running untouched by anything the site does. */

const FROM = 'Rob at canivibecodeit <digest@send.canivibecodeit.com>';
const REPLY_TO = 'digest@canivibecodeit.com';

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Never throws and never blocks a state change: the money has already moved by
   the time most of these send, so a mail outage must not fail the request. */
export async function sendMail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`mail skipped (no RESEND_API_KEY): ${subject}`);
    return false;
  }
  if (!to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, reply_to: REPLY_TO, subject, html, text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`mail failed (${res.status}): ${subject}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`mail failed: ${err?.message || err}`);
    return false;
  }
}

export async function alertRob(subject, html) {
  return sendMail({ to: process.env.DIGEST_ALERT_EMAIL, subject, html });
}

/* Provider-synthesized addresses that can never receive mail; keep them out
   of the digest list, they only bounce and burn sender reputation. */
export function unmailable(email) {
  return /@users\.noreply\.github\.com$/i.test(email);
}

/* Add an email to the digest audience. Inert until the Resend vars are set:
   the site's waitlist table is the source of truth, the audience is a mirror.
   Fire-and-forget: never blocks or fails the caller. Callers must only
   mirror NEW rows so a re-post can't resubscribe someone who unsubscribed
   on Resend's side. */
export function mirrorToResend(email) {
  const key = process.env.RESEND_API_KEY;
  const audience = process.env.RESEND_AUDIENCE_ID;
  if (!key || !audience) return;
  fetch(`https://api.resend.com/audiences/${audience}/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

/* Flip a contact's subscribed state on the Resend audience (the /account
   digest toggle). Resubscribing a missing contact creates it. Returns whether
   Resend confirmed; never throws. No-op true when Resend isn't configured so
   local dev behaves. */
export async function setResendSubscribed(email, subscribed) {
  const key = process.env.RESEND_API_KEY;
  const audience = process.env.RESEND_AUDIENCE_ID;
  if (!key || !audience) return true;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  try {
    const res = await fetch(
      `https://api.resend.com/audiences/${audience}/contacts/${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ unsubscribed: !subscribed }),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (res.ok) return true;
    if (res.status === 404 && subscribed) {
      const created = await fetch(`https://api.resend.com/audiences/${audience}/contacts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, unsubscribed: false }),
        signal: AbortSignal.timeout(10000),
      });
      return created.ok;
    }
    return false;
  } catch {
    return false;
  }
}

/* GDPR account deletion: take the contact off the audience entirely.
   Returns whether Resend confirmed (a 404 counts: already gone); callers
   alert on false so a stray contact never keeps receiving broadcasts. */
export async function deleteResendContact(email) {
  const key = process.env.RESEND_API_KEY;
  const audience = process.env.RESEND_AUDIENCE_ID;
  if (!key || !audience) return true;
  try {
    const res = await fetch(
      `https://api.resend.com/audiences/${audience}/contacts/${encodeURIComponent(email)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) }
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/* Everyone in the Resend audience who has unsubscribed. Unsubscribes live
   there, not in our tables, so anything that mails a local list must check
   here first. Throws when it can't know — mailing blind is worse than not
   mailing. */
export async function unsubscribedEmails() {
  const key = process.env.RESEND_API_KEY;
  const audience = process.env.RESEND_AUDIENCE_ID;
  if (!key || !audience) throw new Error('missing RESEND_API_KEY or RESEND_AUDIENCE_ID');
  const res = await fetch(`https://api.resend.com/audiences/${audience}/contacts`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`resend contacts: HTTP ${res.status}`);
  const body = await res.json();
  return new Set(
    (body?.data ?? [])
      .filter((c) => c.unsubscribed)
      .map((c) => String(c.email).toLowerCase())
  );
}

/* One API call for up to 100 individual emails — each recipient gets their own
   message, nobody sees anybody else. Returns how many were accepted. */
export async function sendBatch(messages) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`batch mail skipped (no RESEND_API_KEY): ${messages.length} messages`);
    return 0;
  }
  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100).map((m) => ({ from: FROM, reply_to: REPLY_TO, ...m }));
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        console.error(`batch mail failed (${res.status}) at chunk ${i / 100}`);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      sent += body?.data?.length ?? chunk.length;
    } catch (err) {
      console.error(`batch mail failed: ${err?.message || err}`);
    }
  }
  return sent;
}

const MONO = "font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;";

export function shell(body) {
  return `<div style="${MONO} font-size:14px; line-height:1.6; color:#171a17; max-width:520px;">${body}</div>`;
}

/* Sponsor-facing mail wears the same card as the newsletter: grey page, white
   card, the logo lockup, and a footer naming who answers replies. Internal
   alerts to Rob keep the bare shell above. */
export function brandShell(body) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background-color:#f2f2f0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2f2f0;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid #e0e0db; border-radius:8px;">
          <tr>
            <td style="padding:40px 48px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:4px 0 30px 0;">
                    <span style="display:inline-block; vertical-align:middle; width:30px; height:30px; line-height:28px; border:3px solid #0e9c47; border-radius:8px; text-align:center; ${MONO} font-size:18px; font-weight:700; color:#0e9c47;">?|</span>
                    <span style="display:inline-block; vertical-align:middle; margin-left:10px; ${MONO} font-size:17px; font-weight:500; color:#111111;">can<span style="color:#0e9c47;">i</span>vibecode<span style="color:#0e9c47;">it</span></span>
                  </td>
                </tr>
              </table>
              <div style="${MONO} font-size:14px; line-height:1.6; color:#171a17;">${body}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e0e0db; margin-top:32px;">
                <tr>
                  <td align="center" style="padding:18px 0 0 0; ${MONO} font-size:11.5px; line-height:18px; color:#6e6e67;">reply to this email and you'll reach Rob, not a bot.</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function button(href, label) {
  return `<a href="${esc(href)}" style="${MONO} display:inline-block; background:#0e9c47;`
    + ` color:#ffffff; font-size:14px; font-weight:700; text-decoration:none;`
    + ` padding:12px 20px; border-radius:8px;">${esc(label)}</a>`;
}
