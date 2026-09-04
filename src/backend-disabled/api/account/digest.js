// The /account digest toggle. The waitlist row is the source of truth for
// membership; the subscribed/unsubscribed state lives on the Resend contact
// (same split the weekly digest script already relies on). The Resend sync is
// what actually stops or starts mail, so a failed sync is a failed request,
// never a silent success.
import { createHash } from 'node:crypto';
import { captureServer } from '../../../lib/analytics.js';
import { addToWaitlist, rateLimit, setUserNewsletter } from '../../../lib/db.js';
import { setResendSubscribed, unmailable } from '../../../lib/mail.js';
import { crossOrigin, json, readBody } from '../../../lib/request.js';

// Where the one-click subscribe was clicked. Client-supplied, so whitelisted;
// anything else counts as the /account toggle.
const PLACEMENTS = ['account', 'app_copy', 'post_vote', 'post_submit'];

export async function POST({ request, locals }) {
  if (!locals.user) return json({ error: 'sign in first' }, 401);
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);
  if (!(await rateLimit(`digest:${locals.user.id}`, 10, 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  const on = body.on === true || body.on === 'true';
  const email = locals.user.email?.trim().toLowerCase();
  if (!email) return json({ error: 'no email on account' }, 400);
  if (on && unmailable(email)) {
    return json({ error: 'your sign-in email cannot receive mail (GitHub no-reply address)' }, 400);
  }

  if (on && (await addToWaitlist(email, 'account'))) {
    // First-time joins only, mirroring /api/waitlist: toggling off and on
    // again must not count twice. /account itself sits behind before_send's
    // private-page filter, so the server is the only place this is countable.
    captureServer(
      'waitlist_signup',
      { placement: PLACEMENTS.includes(body.placement) ? body.placement : 'account' },
      createHash('sha256').update(email).digest('hex').slice(0, 32)
    );
  }
  const synced = await setResendSubscribed(email, on);
  if (!synced) return json({ error: 'subscription update did not stick, try again' }, 502);
  await setUserNewsletter(locals.user.id, on);
  return json({ ok: true, on });
}
